"""Exercise the pinned adapter with real PR-Agent/PyGithub and a finite HTTP fixture."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import re
import runpy
import sys
from urllib.parse import urlparse, parse_qs

from github import GithubException
from github.Requester import Requester

BASE = '1' * 40
HEAD = '2' * 40
ROOT = '/repos/fixture/project'
stream_scope_operations = ('stream-scope', 'named-stream-scope', 'own-stream-scope',
                           'visible-stream-scope', 'visible-incremental-stream-scope')
writes = []
reads = []
unfrozen = []
unmodeled = []
pull = {
    'number': 42, 'id': 42, 'title': 'Fixture change', 'body': '', 'state': 'open', 'draft': True,
    'html_url': 'https://github.com/fixture/project/pull/42', 'url':'https://api.github.com'+ROOT+'/pulls/42', 'issue_url':'https://api.github.com'+ROOT+'/issues/42', 'changed_files': 1, 'commits': 1,
    'additions': 1, 'deletions': 1, 'labels': [], 'user': {'login': 'contributor'},
    'base': {'ref': 'stack/base', 'sha': BASE, 'repo': {'full_name': 'fixture/project'}},
    'head': {'ref': 'change', 'sha': HEAD, 'repo': {'full_name': 'fixture/project'}},
}
file = {'filename': 'app.py', 'status': 'modified', 'additions': 1, 'deletions': 1,
        'changes': 2, 'patch': '@@ -1 +1 @@\n-old = True\n+old = False'}


def request(self, verb, url, parameters=None, headers=None, input=None, **kwargs):
    path = urlparse(url).path
    query = {**parse_qs(urlparse(url).query), **(parameters or {})}
    if verb != 'GET':
        assert path in {ROOT + '/pulls/42/reviews', ROOT + '/issues/42/comments'}, (verb, path)
        writes.append((path, input))
        if path.endswith('/reviews'):
            assert input['commit_id'] == HEAD
        return {}, {'id': 99, 'state': 'COMMENTED', 'commit_id': HEAD,
                    'html_url': 'https://github.com/fixture/project/pull/42#fixture'}
    reads.append(path)
    if path == '/user':
        return {}, {'login':'github-actions[bot]','id':1}
    if path == ROOT:
        return {}, {'id': 1, 'full_name': 'fixture/project', 'default_branch': 'trunk',
                    'owner': {'login': 'fixture', 'type': 'Organization'}}
    if path == ROOT + '/pulls/42':
        return {}, pull
    if path == ROOT + '/pulls/42/files':
        return {}, [file]
    if path == ROOT + '/pulls/42/commits':
        return {}, [{'sha': HEAD, 'commit': {'message': 'Fixture change', 'author': {'date': '2026-01-01T00:00:00Z'}, 'committer': {'date': '2026-01-01T00:00:00Z'}}, 'parents': [{'sha': BASE}]}]
    if path.startswith(ROOT + '/commits/'):
        ref=path.rsplit('/',1)[1]
        if ref not in (BASE,HEAD): unfrozen.append(ref)
        return {}, {'sha':HEAD if ref==HEAD else BASE, 'commit':{'message':'Fixture change','tree':{'sha':'3'*40}}, 'parents':[{'sha':BASE}]}
    if path == ROOT + '/git/trees/'+'3'*40:
        return {}, {'sha':'3'*40,'tree':[{'path':'CLAUDE.md','mode':'100644','type':'blob','sha':'4'*40}], 'truncated':False}
    if path == ROOT + '/git/blobs/'+'4'*40:
        return {}, {'encoding':'base64','content':base64.b64encode(b'Trusted native instructions').decode()}
    if path.startswith(ROOT + '/compare/'):
        return {}, {'files':[file], 'commits':[{'sha':HEAD,'commit':{'message':'Fixture change'}}], 'merge_base_commit':{'sha':BASE}, 'total_commits':1}
    if path == ROOT + '/contents/app.py':
        ref=query.get('ref')
        content=b'old = True' if ref==BASE or ref==[BASE] else b'old = False'
        return {}, {'type':'file','encoding':'base64','content':base64.b64encode(content).decode(),'path':'app.py'}
    if path == ROOT + '/languages':
        return {}, {'Python': 10}
    if path in (ROOT + '/contents/.pr_agent.toml', ROOT + '/contents/.pr_agent.localization.toml') and operation in ('repository-settings','repository-review-output'):
        assert query.get('ref') in (BASE,[BASE]), query
        label = 'LOCALIZATION_ONLY_FIXTURE_CONTEXT' if path.endswith('localization.toml') else 'GENERAL_ONLY_FIXTURE_CONTEXT'
        content = f'[pr_reviewer]\nextra_instructions = "{label}"\n'
        return {}, {'type':'file','encoding':'base64','path':path.rsplit('/',1)[1],'content':base64.b64encode(content.encode()).decode()}
    if path == ROOT + '/contents/CLAUDE.md':
        ref = query.get('ref')
        assert ref == BASE or ref == [BASE], f'Instruction source was not frozen: {ref}'
        return {}, {'type': 'file', 'encoding': 'base64', 'path': 'CLAUDE.md',
                    'content': base64.b64encode(b'Trusted native instructions').decode()}
    if '/contents/' in path or path.startswith('/repos/fixture/') and not path.startswith(ROOT + '/'):
        raise GithubException(404, {'message': 'Not Found'})
    if path == ROOT + '/pulls/42/comments':
        existing=[{'id':88,'body':'<!-- reviewrelay:'+'a'*64+':0 -->','user':{'login':'github-actions[bot]'},'commit_id':HEAD}] if os.environ.get('REVIEW_TEST_REPLAY') else []
        return {}, existing + [{**comment,'id':99+i,'user':{'login':'github-actions[bot]'},'commit_id':HEAD} for path_, payload in writes if path_.endswith('/reviews') for i,comment in enumerate(payload.get('comments',[]))]
    if path == ROOT + '/issues/42/comments':
        if operation in stream_scope_operations:
            prefix = '' if operation == 'named-stream-scope' else '<!-- reviewrelay:stream:localization -->\n\n'
            heading, identity = '## PR Reviewer Guide', '<!-- pr-agent:review:full -->'
            if operation.startswith('visible-'):
                prefix = '<!-- reviewrelay:stream:localization -->\n**Review stream:** `localization`\n'
            if operation == 'visible-incremental-stream-scope':
                heading, identity = '## Incremental PR Reviewer Guide', '<!-- pr-agent:review:incremental -->'
            return {}, [{'id':77,'body':prefix+heading+'\n\n'+identity,'user':{'login':'github-actions[bot]'},'created_at':'2026-01-02T00:00:00Z'}]
        return {}, [{**payload,'id':99,'user':{'login':'github-actions[bot]'}} for path_,payload in writes if path_.endswith('/comments')]
    if path == ROOT + '/pulls/42/reviews':
        return {}, []
    unmodeled.append((verb,path))
    raise AssertionError(f'Unmodeled external HTTP request: {verb} {path}')


Requester.requestJsonAndCheck = request
operation = sys.argv[1]
summarized = operation == 'publish-summarized'
os.environ.update({
    'GITHUB_REPOSITORY': 'fixture/project', 'PR_NUMBER': '42', 'BASE_SHA': BASE, 'HEAD_SHA': HEAD,
    'GITHUB__USER_TOKEN': 'fixture-token', 'GITHUB_ACTIONS': 'true', 'GITHUB__DEPLOYMENT_TYPE': 'user',
    'CONFIG__CONFIG_BRANCH': BASE, 'CONFIG__CLI_MODE': 'true', 'CONFIG__PUBLISH_OUTPUT': 'false',
    'CONFIG__REPO_CONTEXT_FILES': '["CLAUDE.md"]', 'REVIEW_INSTRUCTION_PATHS': '["CLAUDE.md"]', 'CONFIG__REPO_CONTEXT_FROM_DEFAULT_BRANCH': 'true',
    'CONFIG__EXTRA_CONFIG_URL': '/tool/profiles/primary.toml',
    'REVIEW_REPO_SETTINGS_PRESENT': 'false',
    'REVIEW_PUBLICATION_MARKER': '<!-- reviewrelay:'+'a'*64+' -->',
    'OPENAI_CUSTOM_HEADERS': 'x-opencode-session: reviewrelay-fixture/project-42',
})
if operation in ('review-output', 'review-output-disabled', 'repository-review-output', 'scope-mismatch'):
    model_requests = []

    class ModelAPI(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            model_requests.append(request)
            prediction = 'review:\n  relevant_tests: "Yes"\n  security_concerns: "No"\n  key_issues_to_review: []\n'
            response = {
                'id': 'fixture-completion', 'object': 'chat.completion', 'created': 1,
                'model': 'deepseek-v4.1-flash',
                'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': prediction}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 123, 'completion_tokens': 45, 'total_tokens': 168},
            }
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream' if request.get('stream') else 'application/json')
            self.end_headers()
            if request.get('stream'):
                response['object'] = 'chat.completion.chunk'
                response['choices'] = [{'index': 0, 'delta': {'role': 'assistant', 'content': prediction}, 'finish_reason': None}]
                self.wfile.write(('data: ' + json.dumps(response) + '\n\n').encode())
                response['choices'] = [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]
                self.wfile.write(('data: ' + json.dumps(response) + '\n\ndata: [DONE]\n\n').encode())
            else:
                self.wfile.write(json.dumps(response).encode())

    model_api = ThreadingHTTPServer(('127.0.0.1', 0), ModelAPI)
    Thread(target=model_api.serve_forever, daemon=True).start()
    os.environ.update({
        'OPENAI__API_BASE': f'http://127.0.0.1:{model_api.server_port}/v1',
        'OPENAI__KEY': 'fixture-model-key', 'REVIEW_COMMAND': 'review',
        'CONFIG__OUTPUT_RUN_DETAILS': 'false' if operation.endswith('-disabled') else 'true',
        'CONFIG__OUTPUT_RELEVANT_CONFIGURATIONS': 'true', 'PR_REVIEWER__ENABLE_HELP_TEXT': 'true',
    })

if operation in stream_scope_operations and operation != 'stream-scope':
    os.environ['REVIEW_STREAM_MARKER']='<!-- reviewrelay:stream:localization -->'
if operation in ('repository-settings','repository-review-output'):
    os.environ.update({'REVIEW_REPO_SETTINGS_PRESENT':'true','REVIEW_PR_AGENT_CONFIG_PATH':'.pr_agent.localization.toml'})

Path('/output/review.json').write_text(json.dumps({'review': {'key_issues_to_review': []}, 'coverage': {}}))
Path('/output/suggestions.json').write_text(json.dumps({'code_suggestions': [{
    'relevant_file': 'app.py', 'relevant_lines_start': 1, 'relevant_lines_end': 1,
    'existing_code': 'old = False', 'improved_code': 'old = True',
    'suggestion_content': 'Preserve the existing behavior', 'one_sentence_summary': 'Preserve behavior', 'label': 'bug', 'score': 9,
}], 'publication_settings': {'committable_code_suggestions': not summarized}}))
sys.argv = ['/tool/bin/pr-agent-native.py', 'publish-suggestions' if summarized else 'scope' if operation in (*stream_scope_operations, 'provider-settings', 'repository-settings') else operation]
if operation in ('review-output', 'review-output-disabled', 'repository-review-output', 'scope-mismatch'):
    sys.argv = ['/tool/bin/pr-agent-native.py', 'generate', '--pr_url', pull['html_url'],
                '--config-branch', BASE, '--json-output', '/output/review.json', 'review']
if operation == 'scope-mismatch':
    os.environ['REVIEW_SCOPE'] = json.dumps({'incremental': False, 'start': BASE, 'first': None, 'paths': ['different.py']})
captured = io.StringIO()
try:
    with contextlib.redirect_stdout(captured):
        runpy.run_path('/tool/bin/pr-agent-native.py', run_name='__main__')
except RuntimeError as error:
    assert operation == 'scope-mismatch' and str(error) == 'Native review scope changed during this run', str(error)
    assert not model_requests and not writes and not unmodeled
    model_api.shutdown()
    print('Mismatched scope refused before inference')
    sys.exit(0)
except SystemExit as exit:
    assert exit.code in (None, 0), exit.code
if operation == 'scope-mismatch':
    raise AssertionError('Mismatched scope reached generation instead of being refused')
assert not unmodeled, f'Incomplete external HTTP fixture: {unmodeled}'
assert not unfrozen, f'Native configuration read a mutable branch: {unfrozen}'
if operation == 'repository-settings':
    from pr_agent.config_loader import get_settings
    assert get_settings().pr_reviewer.extra_instructions == 'LOCALIZATION_ONLY_FIXTURE_CONTEXT', get_settings().pr_reviewer.extra_instructions
elif operation == 'provider-settings':
    from pr_agent.algo.ai_handlers.litellm_ai_handler import LiteLLMAIHandler
    handler = LiteLLMAIHandler()
    assert handler._request_headers['User-Agent'] == 'ReviewRelay-PR-Agent/1.0'
    assert handler._sdk_header_defaults['custom_headers']['x-opencode-session'] == 'reviewrelay-fixture/project-42'
elif operation in ('own-stream-scope', 'visible-stream-scope', 'visible-incremental-stream-scope'):
    scope=json.loads(captured.getvalue().splitlines()[-1])
    assert scope['incremental'] is True and scope['start'] == HEAD, scope
elif operation in ('scope','stream-scope','named-stream-scope'):
    scope = json.loads(captured.getvalue().splitlines()[-1])
    assert scope == {'incremental': False, 'start': BASE, 'first': None, 'paths': ['app.py']}, scope
elif operation in ('review-output', 'review-output-disabled', 'repository-review-output', 'scope-mismatch'):
    model_api.shutdown()
    assert len(model_requests) == 1, model_requests
    if operation == 'repository-review-output':
        prompt=json.dumps(model_requests[0]['messages'])
        assert 'LOCALIZATION_ONLY_FIXTURE_CONTEXT' in prompt and 'GENERAL_ONLY_FIXTURE_CONTEXT' not in prompt, prompt
    data = json.loads(Path('/output/review.json').read_text())
    assert data['usage'] == {'prompt_tokens': 123, 'completion_tokens': 45, 'total_tokens': 168}, data
    rendered = json.loads(Path('/output/rendered.json').read_text())
    body = rendered['body']
    assert rendered['anchor'] in body, rendered
    assert 'Tool usage guide' in body, body
    assert 'Relevant configurations' in body, body
    if operation.endswith('-disabled'):
        assert 'Agent run details' not in body, body
    else:
        assert 'Agent run details' in body, body
        assert 'openai/deepseek-v4.1-flash' in body, body
        assert '123 in / 45 out / 168 total' in body, body
        assert re.search(r'Time cost.*?\d+\.\ds', body), body
        assert re.search(r'AI calls.*?1', body), body
elif operation in ('publish-suggestions', 'publish-summarized'):
    if os.environ.get('REVIEW_TEST_REPLAY'):
        assert not writes, 'already confirmed suggestions must not be published twice'
    else:
        assert any(path.endswith('/comments' if summarized else '/reviews') for path, _ in writes), writes
        assert ROOT + '/contents/CLAUDE.md' in reads, reads
else:
    raise AssertionError(operation)
if operation not in ('publish-suggestions', 'publish-summarized'):
    assert not writes, writes
print(f'Native {operation}: passed; HTTP writes captured: {len(writes)}; no model credentials supplied.')
