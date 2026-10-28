"""Read current Worker settings; optionally add the two booking origins only."""
import json
import os
import pathlib
import sys
import tomllib
import urllib.request
import urllib.error
from email.parser import BytesParser
from email.policy import default

config = pathlib.Path(os.environ['APPDATA']) / 'xdg.config/.wrangler/config/default.toml'
token = tomllib.loads(config.read_text())['oauth_token']
base = 'https://api.cloudflare.com/client/v4/accounts/e33cd20566f035890048d7a17b42b410/workers/scripts/alex-crm-api'
url = base + '/settings'

def request(method='GET', data=None, content_type=None, target=None):
    headers = {'Authorization': 'Bearer ' + token}
    if content_type:
        headers['Content-Type'] = content_type
    try:
        response = json.load(urllib.request.urlopen(urllib.request.Request(target or url, data=data, headers=headers, method=method)))
    except urllib.error.HTTPError as error:
        print(json.load(error).get('errors'))
        raise SystemExit('Cloudflare rejected settings update')
    if not response.get('success'):
        raise RuntimeError('Cloudflare settings request failed')
    return response['result']

deployments = request(target=base + '/deployments')
version_id = deployments['deployments'][0]['versions'][0]['version_id']
version = request(target=base + '/versions/' + version_id)
print('Active version:', version_id, 'keys:', list(version), 'resource keys:', list(version.get('resources', {})))
before = {'bindings': version['resources']['bindings']}
print('Script metadata:', version['resources']['script'])
binding = next(b for b in before['bindings'] if b['name'] == 'RECEPTIONIST_WEB_ORIGINS')
assert binding['type'] == 'plain_text'
print('Current web origins:', binding['text'])
print('Bindings:', len(before['bindings']))
if '--apply' not in sys.argv:
    sys.exit(0)
origins = list(dict.fromkeys(binding['text'].split(',') + ['https://aleksappliancerepair.com', 'https://www.aleksappliancerepair.com']))
content = urllib.request.urlopen(urllib.request.Request(base + '/content/v2?version=' + version_id, headers={'Authorization': 'Bearer ' + token}))
entrypoint = content.headers['cf-entrypoint']
assert entrypoint
mime = BytesParser(policy=default).parsebytes(('Content-Type: ' + content.headers['Content-Type'] + '\r\n\r\n').encode() + content.read())
assert mime.is_multipart()
settings = {'main_module': entrypoint, 'bindings': [dict(b, text=','.join(origins)) if b['name'] == binding['name'] else b for b in before['bindings'] if b['type'] != 'secret_text'], 'keep_bindings': ['secret_text', 'secret_key'], **version['resources']['script_runtime'], 'annotations': {'workers/message': 'Allow existing voice booking from booking domain; unchanged Worker code'}}
boundary = 'booking-origin-settings-20261023'
body = ('--' + boundary + '\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n' + json.dumps(settings) + '\r\n').encode()
for part in mime.iter_parts():
    name = part.get_param('name', header='content-disposition')
    assert name and '"' not in name
    body += ('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"; filename="' + name + '"\r\nContent-Type: ' + part.get_content_type() + '\r\n\r\n').encode() + part.get_payload(decode=True) + b'\r\n'
body += ('--' + boundary + '--\r\n').encode()
uploaded = request('POST', body, 'multipart/form-data; boundary=' + boundary, target=base + '/versions')
new_version = request(target=base + '/versions/' + uploaded['id'])
assert new_version['resources']['script']['etag'] == version['resources']['script']['etag'], 'Worker code changed'
assert request(target=base + '/deployments')['deployments'][0]['versions'][0]['version_id'] == version_id, 'Concurrent deployment detected'
request('POST', json.dumps({'strategy': 'percentage', 'versions': [{'version_id': uploaded['id'], 'percentage': 100}]}).encode(), 'application/json', target=base + '/deployments')
new_deployment = request(target=base + '/deployments')['deployments'][0]
new_version = request(target=base + '/versions/' + new_deployment['versions'][0]['version_id'])
after = {'bindings': new_version['resources']['bindings']}
old_others = sorted([b for b in before['bindings'] if b['name'] != binding['name']], key=lambda b: b['name'])
new_others = sorted([b for b in after['bindings'] if b['name'] != binding['name']], key=lambda b: b['name'])
assert old_others == new_others, 'Unexpected binding change: investigate before publishing'
assert next(b for b in after['bindings'] if b['name'] == binding['name'])['text'] == ','.join(origins)
print('Updated booking origins; all other bindings preserved.')
