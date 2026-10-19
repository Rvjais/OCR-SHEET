"""Unit tests for the invoice normalizer — no network calls."""
import unittest

from backend.deepseek import NOT_FOUND, normalize_invoice


class NormalizeInvoiceTests(unittest.TestCase):
    def test_missing_values_become_the_literal_not_found(self):
        result = normalize_invoice({})
        self.assertEqual(result["store"], {"name": NOT_FOUND, "address": NOT_FOUND, "state": NOT_FOUND})
        self.assertEqual(result["invoice"]["number"], NOT_FOUND)
        self.assertEqual(result["customer"]["mobile"], NOT_FOUND)
        self.assertEqual(result["items"], [])
        self.assertEqual(result["payable"], {"amount": NOT_FOUND, "account": NOT_FOUND})
        self.assertEqual(result["gst"]["igst"], NOT_FOUND)

    def test_blank_and_null_like_values_collapse_to_not_found(self):
        result = normalize_invoice({
            "store": {"name": "   ", "address": None, "state": "-"},
            "invoice": {"number": "N/A"},
            "customer": {"name": "Ravi", "mobile": "none"},
        })
        self.assertEqual(result["store"]["name"], NOT_FOUND)
        self.assertEqual(result["store"]["address"], NOT_FOUND)
        self.assertEqual(result["store"]["state"], NOT_FOUND)
        self.assertEqual(result["invoice"]["number"], NOT_FOUND)
        self.assertEqual(result["customer"]["name"], "Ravi")
        self.assertEqual(result["customer"]["mobile"], NOT_FOUND)

    def test_amounts_are_cleaned_to_numbers(self):
        result = normalize_invoice({
            "items": [{"description": "Zinc Syrup", "quantity": "2", "rate": "₹98.00", "amount": "1,96.02", "gst_rate": "12%", "gst_amount": "23.52"}],
            "payable": {"amount": "Rs 429.52", "account": "Credit"},
        })
        self.assertEqual(result["items"][0]["quantity"], 2)
        self.assertEqual(result["items"][0]["rate"], 98.0)
        self.assertEqual(result["items"][0]["amount"], 196.02)
        self.assertEqual(result["items"][0]["gst_rate"], "12%")
        self.assertEqual(result["items"][0]["gst_amount"], 23.52)
        self.assertEqual(result["payable"]["amount"], 429.52)
        self.assertEqual(result["payable"]["account"], "Credit")

    def test_mobile_is_normalized_to_digits(self):
        result = normalize_invoice({"customer": {"mobile": "+91 98765-43210"}})
        self.assertEqual(result["customer"]["mobile"], "9876543210")

    def test_unreadable_amounts_do_not_break_the_schema(self):
        result = normalize_invoice({"items": [{"description": "Soap", "rate": "not readable", "amount": "~~~"}]})
        self.assertEqual(result["items"][0]["rate"], NOT_FOUND)
        self.assertEqual(result["items"][0]["amount"], NOT_FOUND)

    def test_non_dict_items_are_skipped(self):
        result = normalize_invoice({"items": ["Zinc Syrup", {"description": "Soap"}]})
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["description"], "Soap")


if __name__ == "__main__":
    unittest.main()
