"""DeepSeek API integration for extracting invoice fields into a fixed JSON schema.

Every value the model cannot read comes back as the exact string "Not found",
so missing data is explicit instead of blank — on screen, in JSON, CSV and Excel.
"""
import json
import logging
import math
import os
import re

import httpx

logger = logging.getLogger(__name__)

DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"
NOT_FOUND = "Not found"
MAX_PROMPT_PRODUCTS = 300
_BLANK_VALUES = {"not found", "n/a", "na", "nil", "none", "-", "—"}

SYSTEM_PROMPT = """You are an expert invoice data-entry operator. You receive the raw OCR text of one scanned invoice: printed labels, printed values and handwritten values (English, Hindi or mixed scripts). Extract exactly the requested fields.

Rules:
1. Map each printed label to its value even when the value is handwritten underneath it or in an adjacent box.
2. Use the exact string "Not found" for any value that is missing, unreadable or not present on the invoice. Never guess, never invent data, never copy a label as a value.
3. "store" is the business that issued the invoice, "customer" is the party billed to (the buyer).
4. "state" is the state taken from the store's address (e.g. "Karnataka"). Extract it separately even when it is only printed inside the address.
5. "mobile" is the customer's mobile number: digits only, drop +91, spaces, dashes and brackets. If several numbers appear, prefer the customer's.
6. Create one item for every product row in the invoice: description exactly as printed (keep pack size and strength), quantity, rate (price per unit before tax) and amount (line total) when shown, plus the GST rate and GST amount for that line when shown.
7. Amounts must be plain numbers without currency symbols, "Rs" or thousands separators (e.g. 1234.50). Percent values such as "18%" stay as printed.
8. "gst" is the invoice-level tax summary (overall rate, total tax amount, CGST, SGST, IGST) as printed.
9. "payable" is the final amount payable after taxes, and the payable account/ledger if the invoice names one (e.g. "Cash", "Credit", "Sundry Debtors").

Return ONLY a valid JSON object with exactly this shape. Every key must be present; use "Not found" where a value is unknown:
{
  "store": {"name": "...", "address": "...", "state": "..."},
  "invoice": {"number": "..."},
  "customer": {"name": "...", "mobile": "..."},
  "items": [
    {"description": "...", "quantity": "...", "rate": "...", "amount": "...", "gst_rate": "...", "gst_amount": "..."}
  ],
  "gst": {"rate": "...", "amount": "...", "cgst": "...", "sgst": "...", "igst": "..."},
  "payable": {"amount": "...", "account": "..."}
}
"""


def _text(value) -> str:
    if value is None or isinstance(value, bool):
        return NOT_FOUND
    text = str(value).strip().strip('"').strip()
    return NOT_FOUND if not text or text.lower() in _BLANK_VALUES else text


def _amount(value):
    """Numbers stay numbers; anything unreadable becomes "Not found"."""
    if value is None or isinstance(value, bool):
        return NOT_FOUND
    if isinstance(value, (int, float)):
        return int(value) if float(value).is_integer() else float(value)
    text = _text(value)
    if text == NOT_FOUND:
        return NOT_FOUND
    cleaned = re.sub(r"[^\d.-]", "", text)
    try:
        number = float(cleaned)
    except ValueError:
        return NOT_FOUND
    return int(number) if number.is_integer() else number


def _mobile(value) -> str:
    text = _text(value)
    if text == NOT_FOUND:
        return NOT_FOUND
    digits = re.sub(r"\D", "", text)
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    return digits if len(digits) >= 6 else text


def _section(raw, key):
    value = raw.get(key)
    return value if isinstance(value, dict) else {}


def normalize_invoice(raw) -> dict:
    """Force the fixed schema and the "Not found" rule on the model output."""
    raw = raw if isinstance(raw, dict) else {}
    store = _section(raw, "store")
    invoice = _section(raw, "invoice")
    customer = _section(raw, "customer")
    gst = _section(raw, "gst")
    payable = _section(raw, "payable")
    items = []
    for item in raw.get("items") if isinstance(raw.get("items"), list) else []:
        if not isinstance(item, dict):
            continue
        items.append({
            "description": _text(item.get("description")),
            "quantity": _amount(item.get("quantity")),
            "rate": _amount(item.get("rate")),
            "amount": _amount(item.get("amount")),
            "gst_rate": _text(item.get("gst_rate")),
            "gst_amount": _amount(item.get("gst_amount")),
        })
    return {
        "store": {"name": _text(store.get("name")), "address": _text(store.get("address")), "state": _text(store.get("state"))},
        "invoice": {"number": _text(invoice.get("number"))},
        "customer": {"name": _text(customer.get("name")), "mobile": _mobile(customer.get("mobile"))},
        "items": items,
        "gst": {"rate": _text(gst.get("rate")), "amount": _amount(gst.get("amount")),
                "cgst": _amount(gst.get("cgst")), "sgst": _amount(gst.get("sgst")), "igst": _amount(gst.get("igst"))},
        "payable": {"amount": _amount(payable.get("amount")), "account": _text(payable.get("account"))},
    }


def _product_lines(products) -> list:
    """Compact reference lines from the uploaded product/price list."""
    lines = []
    for product in products if isinstance(products, list) else []:
        if not isinstance(product, dict):
            continue
        name = " ".join(str(product.get("name", "")).split())
        if not name or len(name) > 160:
            continue
        price = product.get("price")
        if isinstance(price, str):
            cleaned = re.sub(r"[^\d.-]", "", price)
            try:
                price = float(cleaned)
            except ValueError:
                price = None
        if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price):
            price = None
        line = f"- {name}"
        if price is not None:
            line += f" — ₹{float(price):.2f}"
        lines.append(line)
        if len(lines) >= MAX_PROMPT_PRODUCTS:
            break
    return lines


def build_system_prompt(products=None) -> str:
    """Base extraction prompt, extended with the store's product reference.

    Sending the relevant names and prices lets the model read handwriting by
    choosing the catalog product whose name *and* rate the invoice agrees with,
    instead of guessing a similar-looking spelling.
    """
    lines = _product_lines(products)
    if not lines:
        return SYSTEM_PROMPT
    return (
        SYSTEM_PROMPT
        + "\nPRODUCT AND PRICE REFERENCE (the store's own product list):\n"
        + "\n".join(lines)
        + "\n\nUse this reference to read handwritten or badly scanned product names: when a line clearly refers to a "
          "reference product, write its exact name in \"description\". Use the reference price as a clue to identify the "
          "product (similar products may differ only by strength or pack size) — pick the product whose rate matches the "
          "printed rate. Never change the printed quantity, rate, amount or GST to fit the reference, and never invent a "
          "product: if the scanned product is not clearly in the reference, keep the printed description exactly as it is."
    )


async def parse_invoice_with_deepseek(text: str, api_key: str = None, products=None) -> dict:
    key = (api_key or os.environ.get("DEEPSEEK_API_KEY", "")).strip()
    if not key:
        from .config import load_server_config
        load_server_config()
        key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        raise ValueError("DeepSeek API key is not configured on the server. Please check DEEPSEEK_API_KEY.")

    payload = {
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content": build_system_prompt(products)},
            {"role": "user", "content": f"Here is the raw OCR text of an invoice:\n\n{text}\n\nExtract the requested fields as the JSON object."}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1
    }

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json"
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(DEEPSEEK_API_URL, json=payload, headers=headers)
        if response.status_code == 401:
            raise ValueError("Invalid DeepSeek API key. Please check your key.")
        if response.status_code != 200:
            logger.error("DeepSeek API error %s: %s", response.status_code, response.text)
            raise RuntimeError(f"DeepSeek API error ({response.status_code}): {response.text}")

        data = response.json()
        content = data["choices"][0]["message"]["content"]
        return normalize_invoice(json.loads(content))
