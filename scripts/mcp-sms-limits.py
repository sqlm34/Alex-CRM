"""Configure only the owner-approved MCP Verify limits; credentials arrive on stdin."""
import base64
import json
import sys
import urllib.parse
import urllib.request

SERVICE = 'VAc7647768e95a99b184ab9a55aea957ce'
ROOT = f'https://verify.twilio.com/v2/Services/{SERVICE}/RateLimits'


def main():
    credentials = json.loads(sys.stdin.read())
    auth = base64.b64encode((credentials['sid'] + ':' + credentials['token']).encode()).decode()

    def request(url, data=None):
        if not url.startswith(ROOT):
            raise ValueError('Unexpected endpoint')
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, headers={
            'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded'})
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.load(response)

    limits = request(ROOT + '?PageSize=1000')['rate_limits']
    result = []
    for name, maximum, interval in [('mcp_phone', 3, 3600), ('mcp_global', 10, 86400)]:
        matches = [row for row in limits if row['unique_name'] == name]
        if len(matches) > 1:
            raise ValueError('Ambiguous rate limit')
        limit = matches[0] if matches else request(ROOT, {'UniqueName': name, 'Description': 'MCP public login guard'})
        url = ROOT + '/' + limit['sid'] + '/Buckets'
        buckets = request(url + '?PageSize=1000')['buckets']
        matching = [row for row in buckets if row['interval'] == interval]
        if matching and matching[0]['max'] != maximum:
            raise ValueError('Existing bucket differs; refusing automatic overwrite')
        if not matching:
            request(url, {'Max': maximum, 'Interval': interval})
        verified = request(url + '?PageSize=1000')['buckets']
        if not any(row['interval'] == interval and row['max'] == maximum for row in verified):
            raise ValueError('Read-back verification failed')
        result.append({'key': name, 'max': maximum, 'interval': interval, 'verified': True})
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'status': getattr(error, 'code', None)}))
        sys.exit(1)
