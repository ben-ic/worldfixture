"""AWS SigV4 for this standard-library example's complete S3 HTTP requests."""

import datetime
import hashlib
import hmac
import urllib.parse
import urllib.request


def signed_request(url, bindings, *, method="GET", data=None, headers=None, now=None):
    access = bindings.get("S3_ACCESS_KEY_ID")
    secret = bindings.get("S3_SECRET_ACCESS_KEY")
    region = bindings.get("S3_REGION")
    if not all((access, secret, region)):
        raise ValueError("S3 requests require this run's access key, secret, and region")
    target = urllib.parse.urlsplit(url)
    if target.scheme not in ("http", "https") or target.username or target.password:
        raise ValueError("S3 requires an HTTP URL without embedded credentials")
    body = data.encode("utf-8") if isinstance(data, str) else data
    payload_hash = hashlib.sha256(body or b"").hexdigest()
    timestamp = (now or datetime.datetime.now(datetime.UTC)).strftime("%Y%m%dT%H%M%SZ")
    date = timestamp[:8]
    signed_headers = {key.lower(): " ".join(str(value).split()) for key, value in (headers or {}).items()
                      if key.lower() != "authorization"}
    signed_headers.update({"host": target.netloc, "x-amz-date": timestamp, "x-amz-content-sha256": payload_hash})
    names = ";".join(sorted(signed_headers))
    canonical_headers = "".join(f"{key}:{signed_headers[key]}\n" for key in sorted(signed_headers))
    def quote(value):
        return urllib.parse.quote(value, safe="-_.~")

    path = "/".join(quote(urllib.parse.unquote(part)) for part in (target.path or "/").split("/"))
    query = "&".join(f"{key}={value}" for key, value in sorted(
        (quote(key), quote(value)) for key, value in urllib.parse.parse_qsl(target.query, keep_blank_values=True)))
    canonical = "\n".join([method.upper(), path, query, canonical_headers, names, payload_hash])
    scope = f"{date}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", timestamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    signing_key = f"AWS4{secret}".encode()
    for value in (date, region, "s3", "aws4_request"):
        signing_key = hmac.new(signing_key, value.encode(), hashlib.sha256).digest()
    signature = hmac.new(signing_key, to_sign.encode(), hashlib.sha256).hexdigest()
    signed_headers["authorization"] = f"AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={names}, Signature={signature}"
    return urllib.request.Request(url, data=body, method=method.upper(), headers=signed_headers)


def s3_request(url, bindings, *, method="GET", data=None, content_type=None):
    headers = {"content-type": content_type} if content_type else {}
    request = signed_request(url, bindings, method=method, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.status, response.read()
