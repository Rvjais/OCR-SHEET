"""DeepSeek API integration for structuring invoice OCR text into tabular/JSON data."""
import json
import logging
import os
import httpx

logger = logging.getLogger(__name__)

DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"

SYSTEM_PROMPT = """You are an expert invoice parser and accountant.
Your task is to take raw OCR text (from scanned or photographed invoices containing printed labels and handwritten or printed values) and organize the data into a clean, comprehensive, structured JSON format.

Guidelines:
1. Carefully map printed labels to their corresponding values, even if the value was written underneath or in an adjacent box.
2. For line items, extract every single item row into the "items" list with description, HSN/SAC code, quantity, unit price, and total line amount.
3. Keep quantities and amounts as numbers (floats/integers) where possible.
4. Extract all tax details (SGST, CGST, IGST, etc.) and grand totals accurately.
5. If a value is missing or illegible, use null or an empty string. Never invent fake data.

Return ONLY a valid JSON object matching this schema:
{
  "seller": {
    "name": "Seller/Store name",
    "address": "Full address",
    "email": "Email address if present",
    "phone": "Phone number if present"
  },
  "invoice_details": {
    "invoice_no": "Invoice number or null",
    "date": "Invoice date",
    "terms": "Payment terms (e.g. Net 30 Days)",
    "customer_id": "Customer ID if present"
  },
  "billing_address": {
    "name": "Customer / Billed to name",
    "phone": "Customer phone number",
    "address": "Customer address"
  },
  "shipping_address": {
    "name": "Ship to name",
    "address": "Ship to address"
  },
  "items": [
    {
      "description": "Item description",
      "hsn_code": "HSN/SAC code",
      "qty": 1,
      "unit_price": 0.0,
      "amount": 0.0
    }
  ],
  "totals": {
    "subtotal": 0.0,
    "freight_charges": 0.0,
    "sgst_rate": "9%",
    "sgst_amount": 0.0,
    "cgst_rate": "9%",
    "cgst_amount": 0.0,
    "grand_total": 0.0,
    "amount_in_words": "Amount in words"
  },
  "payment_notes": "e.g. Cheque in favour of..."
}
"""

async def parse_invoice_with_deepseek(text: str, api_key: str = None) -> dict:
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
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Here is the raw OCR text of an invoice:\n\n{text}\n\nParse it into the required JSON structure."}
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
        return json.loads(content)

