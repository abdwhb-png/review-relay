"""Exercise the pinned adapter with real PR-Agent/PyGithub and a finite HTTP fixture."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import sys
from urllib.parse import urlparse, parse_qs

from github import GithubException
from github.Requester import Requester

BASE = '1' * 40
HEAD = '2' * 40
ROOT = '/repos/fixture/project'
writes = []
reads = []
unfrozen = []
unmodeled = []
pull = {
    'number': 42, 'id': 42, 'title': 'Fixture change', 'body': '', 'state': 'open', 'draft': False,
    'html_url': 'https://github.com/fixture/project/pull/42', 'url':'https://api.github.com'+ROOT+'/pulls/42', 'issue_url':'https://api.github.com'+ROOT+'/issues/42', 'changed_files': 1, 'commits': 1,
    'additions': 1, 'deletions': 1, 'labels': [], 'user': {'login': 'contributor'},
    'base': {'ref': 'trunk', 'sha': BASE, 'repo': {'full_name': 'fixture/project'}},
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
    if path == ROOT:
        return {}, {'id': 1, 'full_name': 'fixture/project', 'default_branch': 'trunk',
                    'owner': {'login': 'fixture', 'type': 'Organization'}}
    if path == ROOT + '/pulls/42':
        return {}, pull
    if path == ROOT + '/pulls/42/files':
        return {}, [file]
    if path == ROOT + '/pulls/42/commits':
        return {}, [{'sha': HEAD, 'commit': {'message': 'Fixture change'}, 'parents': [{'sha': BASE}]}]
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
})
Path('/output/review.json').write_text(json.dumps({'review': {'key_issues_to_review': []}, 'coverage': {}}))
Path('/output/suggestions.json').write_text(json.dumps({'code_suggestions': [{
    'relevant_file': 'app.py', 'relevant_lines_start': 1, 'relevant_lines_end': 1,
    'existing_code': 'old = False', 'improved_code': 'old = True',
    'suggestion_content': 'Preserve the existing behavior', 'one_sentence_summary': 'Preserve behavior', 'label': 'bug', 'score': 9,
}], 'publication_settings': {'committable_code_suggestions': not summarized}}))
sys.argv = ['/tool/bin/pr-agent-native.py', 'publish-suggestions' if summarized else 'scope' if operation == 'provider-settings' else operation]
captured = io.StringIO()
try:
    with contextlib.redirect_stdout(captured):
        runpy.run_path('/tool/bin/pr-agent-native.py', run_name='__main__')
except SystemExit as exit:
    assert exit.code in (None, 0), exit.code
assert not unmodeled, f'Incomplete external HTTP fixture: {unmodeled}'
assert not unfrozen, f'Native configuration read a mutable branch: {unfrozen}'
if operation == 'provider-settings':
    from pr_agent.algo.ai_handlers.litellm_ai_handler import LiteLLMAIHandler
    handler = LiteLLMAIHandler()
    assert handler._request_headers['User-Agent'] == 'ReviewRelay-PR-Agent/1.0'
elif operation == 'scope':
    scope = json.loads(captured.getvalue().splitlines()[-1])
    assert scope == {'incremental': False, 'start': BASE, 'first': None, 'paths': ['app.py']}, scope
elif operation == 'render':
    rendered = json.loads(Path('/output/rendered.json').read_text())
    assert rendered['body'] and rendered['anchor']
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
