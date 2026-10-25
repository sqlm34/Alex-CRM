"""Guarded MCP release preserving all existing Worker bindings and secrets."""
import argparse
import json
import os
from pathlib import Path
import tomllib
import urllib.request
import urllib.error

parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true')
parser.add_argument('--expected-version', required=True)
parser.add_argument('--enable-writes', action='store_true')
parser.add_argument('--restore-bindings-from', help='Reviewed known-good version; retains current secrets')
parser.add_argument('--review-secret-version', help='Unpublished version containing only the additional review database secret')
parser.add_argument('--directory-challenge', help='Public OpenAI domain ownership challenge')
parser.add_argument('--enable-review', action='store_true', help='Enable the owner-approved isolated moderator account')
args = parser.parse_args()
token = tomllib.loads((Path(os.environ['APPDATA']) / 'xdg.config/.wrangler/config/default.toml').read_text())['oauth_token']
base = 'https://api.cloudflare.com/client/v4/accounts/e33cd20566f035890048d7a17b42b410/workers/scripts/alex-crm-api'

def request(path, method='GET', data=None, content_type='application/json'):
    req = urllib.request.Request(base + path, data=data, method=method,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': content_type})
    try:
        result = json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as error:
        failure = json.load(error)
        print('Cloudflare errors:', failure.get('errors'))
        raise SystemExit('Release request rejected; active version unchanged') from None
    if not result.get('success'):
        raise RuntimeError('Cloudflare request rejected')
    return result['result']

def active():
    versions = request('/deployments')['deployments'][0]['versions']
    assert len(versions) == 1 and versions[0]['percentage'] == 100, 'Split deployment requires manual review'
    return versions[0]['version_id']

assert active() == args.expected_version, 'Active deployment changed; review before release'
before = request('/versions/' + args.expected_version)
if args.restore_bindings_from:
    baseline = request('/versions/' + args.restore_bindings_from)
    secret_names = lambda version: {b['name'] for b in version['resources']['bindings'] if b['type'] in ('secret_text', 'secret_key')}
    assert secret_names(before) == secret_names(baseline), 'Secret sets differ; cannot safely restore bindings'
    before = baseline
bindings = list(before['resources']['bindings'])
if args.review_secret_version:
    assert request('/versions')['items'][0]['id'] == args.review_secret_version, 'Secret source must still be the latest version'
    secret_source = request('/versions/' + args.review_secret_version)['resources']['bindings']
    old_secrets = {b['name']: b for b in bindings if b['type'] in ('secret_text', 'secret_key')}
    new_secrets = {b['name']: b for b in secret_source if b['type'] in ('secret_text', 'secret_key')}
    assert set(new_secrets) == set(old_secrets) | {'MCP_REVIEW_DATABASE_URL'}, 'Unexpected secret changes'
    assert all(new_secrets[name] == value for name, value in old_secrets.items()), 'Existing secret metadata changed'
    if 'MCP_REVIEW_DATABASE_URL' not in old_secrets:
        bindings.append(new_secrets['MCP_REVIEW_DATABASE_URL'])
existing_config = next((json.loads(b['text']) for b in bindings if b['name'] == 'MCP_CONFIG' and b['type'] == 'plain_text'), {})
updates = {
    'MCP_ENABLED': 'true', 'MCP_WRITES_ENABLED': 'true' if args.enable_writes else 'false',
    'MCP_RESOURCE_URL': 'https://alex-crm-api.alexeasyrepair.workers.dev/mcp',
    'MCP_OAUTH_ISSUER': 'https://dev-k21kvn04qqxt0swn.us.auth0.com/',
    'MCP_OAUTH_JWKS_URL': 'https://dev-k21kvn04qqxt0swn.us.auth0.com/.well-known/jwks.json',
    'MCP_OAUTH_PHONE_CLAIM_NAMESPACE': 'https://alex-crm-api.alexeasyrepair.workers.dev/mcp/identity',
    'MCP_CONFIRM_CLIENT_ID': 'DfnVKD7AW1bL37QhdKvWGJE1j2CkMiGG',
    'MCP_CONFIRM_AUTH_URL': 'https://dev-k21kvn04qqxt0swn.us.auth0.com/authorize',
    'MCP_CONFIRM_TOKEN_URL': 'https://dev-k21kvn04qqxt0swn.us.auth0.com/oauth/token',
    'MCP_CONFIRM_CONNECTION': 'sms',
}
updates = {**existing_config, **updates}
if args.enable_review:
    assert any(b['name'] == 'MCP_REVIEW_DATABASE_URL' and b['type'] == 'secret_text' for b in bindings), 'Review database secret missing'
    updates['MCP_REVIEW_SUBJECT'] = 'auth0|6ade8fead0ea7929a8a73df1'
    updates['MCP_REVIEW_CLIENT_IDS'] = '8jZoEGPgYpsWIaqlvoAa6p12qfPOyMWl,DfnVKD7AW1bL37QhdKvWGJE1j2CkMiGG'
if args.directory_challenge:
    import re
    assert re.fullmatch(r'[A-Za-z0-9_-]{20,200}', args.directory_challenge), 'Invalid public challenge'
    updates['MCP_DIRECTORY_CHALLENGE'] = args.directory_challenge
updates = {'MCP_ENABLED': updates.pop('MCP_ENABLED'), 'MCP_WRITES_ENABLED': updates.pop('MCP_WRITES_ENABLED'),
    'MCP_CONFIG': json.dumps(updates, separators=(',', ':'))}
assert all(b['type'] == 'plain_text' for b in bindings if b['name'] in updates)
preserved = [b for b in bindings if b['name'] not in updates]
metadata = {**before['resources']['script_runtime'], 'main_module': 'index.js',
    'bindings': [b for b in preserved if b['type'] not in ('secret_text', 'secret_key')]
        + [{'type': 'plain_text', 'name': k, 'text': v} for k, v in updates.items()],
    'keep_bindings': ['secret_text', 'secret_key'],
    'annotations': {'workers/message': 'MCP owner-verified booking; preserve all existing CRM configuration' if args.enable_writes else 'MCP verified reads; writes off; preserve all existing CRM configuration'}}
bundle = Path('artifacts/mcp-release/index.js').read_bytes()
assert b'MCP_WRITES_ENABLED' in bundle and b'MCP_ENABLED' in bundle
print('Preflight:', len(preserved), 'existing bindings preserved; MCP writes', updates['MCP_WRITES_ENABLED'], '; bundle bytes', len(bundle))
if not args.apply:
    raise SystemExit(0)
boundary = 'mcp-verified-release-20261025'
body = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'
    + json.dumps(metadata) + '\r\n').encode()
body += (f'--{boundary}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\n'
    'Content-Type: application/javascript+module\r\n\r\n').encode() + bundle
body += f'\r\n--{boundary}--\r\n'.encode()
uploaded = request('/versions', 'POST', body, 'multipart/form-data; boundary=' + boundary)
candidate = request('/versions/' + uploaded['id'])
sort = lambda values: sorted(values, key=lambda b: b['name'])
assert sort([b for b in candidate['resources']['bindings'] if b['name'] not in updates]) == sort(preserved), 'Unrelated bindings changed'
assert {b['name']: b['text'] for b in candidate['resources']['bindings'] if b['name'] in updates} == updates
assert candidate['resources']['script']['handlers'] == before['resources']['script']['handlers'], 'Worker handlers changed'
assert active() == args.expected_version, 'Concurrent release detected; candidate not activated'
request('/deployments', 'POST', json.dumps({'strategy': 'percentage', 'versions': [{'version_id': uploaded['id'], 'percentage': 100}]}).encode())
assert active() == uploaded['id']
print('Active MCP release:', uploaded['id'], 'Rollback:', args.expected_version)
