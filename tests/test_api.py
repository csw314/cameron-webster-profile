"""Contract and end-to-end checks against the actual trained checkpoint."""
import base64
import io
import json
from pathlib import Path
import sys
import unittest

from PIL import Image, ImageDraw
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
from main import app, CHEEKY_MESSAGE


def payload(image):
    buffer = io.BytesIO(); image.save(buffer, format="PNG")
    return {"image": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()}


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)

    def test_health_confirms_loaded_model(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")
        self.assertEqual(response.json()["model_version"], "mnist-reject-cnn-v1")

    def test_mnist_examples_recognized(self):
        for digit in range(10):
            with self.subTest(digit=digit):
                image = Image.open(ROOT / f"projects/mnist/examples/digit-{digit}.png")
                response = self.client.post("/predict", json=payload(image))
                self.assertEqual(response.status_code, 200)
                result = response.json()
                self.assertTrue(result["accepted"], result)
                self.assertEqual(result["digit"], digit)
                self.assertEqual(len(result["scores"]), 10)

    def test_blank_is_rejected(self):
        response = self.client.post("/predict", json=payload(Image.new("RGB", (320, 320))))
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["accepted"])
        self.assertIsNone(response.json()["digit"])
        self.assertEqual(response.json()["reason"], "blank_drawing")
        self.assertEqual(response.json()["message"], CHEEKY_MESSAGE)

    def test_multi_digit_input_is_rejected(self):
        image = Image.new("L", (320, 320))
        for digit, x in [(2, 30), (7, 170)]:
            sample = Image.open(ROOT / f"projects/mnist/examples/digit-{digit}.png").resize((120, 180))
            image.paste(sample, (x, 70))
        response = self.client.post("/predict", json=payload(image))
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["accepted"])
        self.assertEqual(response.json()["message"], CHEEKY_MESSAGE)

    def test_cross_is_rejected(self):
        image = Image.new("L", (320, 320))
        draw = ImageDraw.Draw(image)
        draw.line((70, 70, 250, 250), fill=255, width=20)
        draw.line((70, 250, 250, 70), fill=255, width=20)
        response = self.client.post("/predict", json=payload(image))
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["accepted"])

    def test_malformed_requests_are_validation_errors(self):
        for data in [{}, {"image": "not-base64"}, {"image": "data:image/jpeg;base64,AAAA"}, {"image": "a" * 660000}, {"image": "AAAA", "extra": True}]:
            with self.subTest(keys=list(data)):
                self.assertEqual(self.client.post("/predict", json=data).status_code, 422)

    def test_oversized_body_is_rejected(self):
        self.assertEqual(self.client.post("/predict", content=b"x" * 710000).status_code, 413)

    def test_oversized_image_dimensions_are_rejected(self):
        self.assertEqual(self.client.post("/predict", json=payload(Image.new("L", (1100, 20)))).status_code, 422)

    def test_cors_allows_portfolio_origin(self):
        response = self.client.options("/predict", headers={"Origin": "https://csw314.github.io", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], "https://csw314.github.io")

    def test_cors_does_not_allow_other_origins(self):
        response = self.client.options("/predict", headers={"Origin": "https://unrelated.example", "Access-Control-Request-Method": "POST"})
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_model_metadata_has_measured_evaluation(self):
        metadata = self.client.get("/model-info").json()
        self.assertEqual(metadata["metrics"]["mnist_test_count"], 10000)
        self.assertGreater(metadata["metrics"]["digit_accuracy_before_rejection"], .97)
        self.assertGreater(metadata["metrics"]["negative_rejection_rate"], .9)


if __name__ == "__main__":
    unittest.main()
