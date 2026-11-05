"""Release Worker code only, retaining and verifying every live binding."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tomllib
import urllib.request
from email.parser import BytesParser
from email.policy import default

parser = argparse.ArgumentParser()
parser.add_argument('--expected-version', required=True)
parser.add_argument('--bundle')
parser.add_argument('--apply', action='store_true')
parser.add_argument('--message', default='CRM code update; all live bindings preserved')
args = parser.parse_args()
token = tomllib.loads((Path(os.environ['APPDATA']) / 'xdg.config/.wrangler/config/default.toml').read_text())['oauth_token']
base = 'https://api.cloudflare.com/client/v4/accounts/e33cd20566f035890048d7a17b42b410/workers/scripts/alex-crm-api'

def request(path, method='GET', data=None, content_type='application/json'):
    req = urllib.request.Request(base + path, data=data, method=method,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': content_type})
    result = json.load(urllib.request.urlopen(req))
    assert result.get('success'), 'Cloudflare request failed'
    return result['result']

def active():
    versions = request('/deployments')['deployments'][0]['versions']
    assert len(versions) == 1 and versions[0]['percentage'] == 100
    return versions[0]['version_id']

assert active() == args.expected_version, 'Active version changed'
before = request('/versions/' + args.expected_version)
content = urllib.request.urlopen(urllib.request.Request(base + '/content/v2?version=' + args.expected_version,
    headers={'Authorization': 'Bearer ' + token}))
mime = BytesParser(policy=default).parsebytes(('Content-Type: ' + content.headers['Content-Type'] + '\r\n\r\n').encode() + content.read())
parts = list(mime.iter_parts())
assert len(parts) == 1 and content.headers['cf-entrypoint'] == 'index.js', 'Review multi-module deployment separately'
Path('artifacts').mkdir(exist_ok=True)
Path('artifacts/worker-before.js').write_bytes(parts[0].get_payload(decode=True))
print('Active:', args.expected_version, 'bindings:', len(before['resources']['bindings']))
print('Code SHA256:', hashlib.sha256(parts[0].get_payload(decode=True)).hexdigest())
if not args.apply:
    raise SystemExit(0)
assert args.bundle
bundle = Path(args.bundle).read_bytes()
bindings = before['resources']['bindings']
metadata = {**before['resources']['script_runtime'], 'main_module': 'index.js',
    'bindings': [b for b in bindings if b['type'] not in ('secret_text', 'secret_key')],
    'keep_bindings': ['secret_text', 'secret_key'],
    'annotations': {'workers/message': args.message}}
boundary = 'crm-code-release-20261104'
body = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'
    + json.dumps(metadata) + '\r\n').encode()
body += (f'--{boundary}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\n'
    'Content-Type: application/javascript+module\r\n\r\n').encode() + bundle + f'\r\n--{boundary}--\r\n'.encode()
uploaded = request('/versions', 'POST', body, 'multipart/form-data; boundary=' + boundary)
candidate = request('/versions/' + uploaded['id'])
assert sorted(candidate['resources']['bindings'], key=lambda b: b['name']) == sorted(bindings, key=lambda b: b['name']), 'Bindings changed; candidate not activated'
assert candidate['resources']['script']['handlers'] == before['resources']['script']['handlers']
assert candidate['resources']['script_runtime'] == before['resources']['script_runtime']
assert active() == args.expected_version, 'Concurrent deployment; candidate not activated'
request('/deployments', 'POST', json.dumps({'strategy': 'percentage', 'versions': [{'version_id': uploaded['id'], 'percentage': 100}]}).encode())
assert active() == uploaded['id']
print('Released:', uploaded['id'], 'Rollback:', args.expected_version)
