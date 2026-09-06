import datetime
import hashlib
import unittest
from unittest.mock import patch

from s3_signing import s3_request, signed_request


class S3SigningTest(unittest.TestCase):
    credentials = {"S3_ACCESS_KEY_ID": "AKIAIOSFODNN7EXAMPLE",
                   "S3_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "S3_REGION": "us-east-1"}
    now = datetime.datetime(2013, 5, 24, tzinfo=datetime.UTC)

    def test_aws_published_get_vector(self):
        request = signed_request("https://examplebucket.s3.amazonaws.com/test.txt", self.credentials,
                                 headers={"Range": "bytes=0-9"}, now=self.now)
        self.assertTrue(request.get_header("Authorization").endswith(
            "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"))

    def test_put_signs_exact_utf8_bytes_and_content_type(self):
        request = signed_request("http://localhost:4321/bucket/a%20b", self.credentials,
                                 method="PUT", data="café", headers={"content-type": "text/plain"}, now=self.now)
        self.assertEqual(request.data, "café".encode())
        self.assertEqual(request.get_header("Host"), "localhost:4321")
        self.assertEqual(request.get_header("X-amz-content-sha256"), hashlib.sha256(request.data).hexdigest())
        self.assertIn("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date", request.get_header("Authorization"))

    def test_missing_credentials_fail_before_network(self):
        with patch("urllib.request.urlopen") as opener:
            with self.assertRaises(ValueError):
                s3_request("http://localhost/bucket", {})
            opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()
