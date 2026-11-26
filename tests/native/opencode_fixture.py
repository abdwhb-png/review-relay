"""Verify instruction delivery and exported-session continuation against a local model stub."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

requests = []
checkpoint_reads = []


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(payload)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        tools = {item['function']['name']: item['function'] for item in payload.get('tools', [])}
        call = None
        if len(requests) == 1 and 'bash' in tools:
            call = ('bash', {'command': 'touch /tmp/reviewrelay-executed',
                             'description': 'Fixture sandbox probe'})
        elif checkpoint_reads and 'read' in tools:
            path = checkpoint_reads.pop(0)
            call = ('read', {'filePath': str(path), 'path': str(path), 'offset': 1, 'limit': 30})
        if call:
            name, values = call
            properties = tools[name]['parameters']['properties']
            arguments = {key: value for key, value in values.items() if key in properties}
            tool_call = {'index': 0, 'id': f'call_fixture_{len(requests)}', 'type': 'function',
                         'function': {'name': name, 'arguments': json.dumps(arguments)}}
            chunks = [({'role': 'assistant', 'tool_calls': [tool_call]}, None), ({}, 'tool_calls')]
        else:
            chunks = [({'role': 'assistant', 'content': 'Native review fixture'}, None), ({}, 'stop')]
        for delta, finish in chunks:
            chunk = {'id': 'chatcmpl-fixture', 'object': 'chat.completion.chunk', 'created': 1,
                     'model': 'deepseek-v4.1-flash',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')


server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='native-opencode-') as directory:
    root = Path(directory)
    project = root / 'project'
    project.mkdir()
    subprocess.run(['git', 'init', '--quiet', '--template=', str(project)], check=True)
    (project / 'CLAUDE.md').write_text('Trusted native CLAUDE instruction sentinel')
    (project / 'policy').mkdir()
    (project / 'policy' / 'rules.md').write_text('Trusted custom glob sentinel')
    project_config = {
        'instructions': ['CLAUDE.md', 'policy/*.md'],
        'agents': {'review': {'permissions':[{'action':'bash','resource':'*','effect':'allow'}]}},
        'provider': {name: {'options': {'baseURL': f'http://127.0.0.1:{server.server_port}/v1', 'apiKey': 'fixture-key'}} for name in ['opencode-go','openrouter']},
    }
    (project / 'opencode.jsonc').write_text('// Native JSONC project configuration\n' + json.dumps(project_config))
    profile = json.loads(Path('/output/defaults-primary.json').read_text())

    def environment(name, route='primary'):
        state = root / name
        defaults = state / 'config/opencode'
        defaults.mkdir(parents=True)
        selected = json.loads(Path(f'/output/defaults-{route}.json').read_text())
        (defaults / 'opencode.json').write_text(json.dumps(selected))
        inline = {'permissions':profile['permissions']}
        if route == 'fallback': inline['model'] = selected['model']
        env = {'PATH': os.environ['PATH'], 'HOME': str(state), 'OPENCODE_API_KEY': 'fixture-key',
               'OPENCODE_CONFIG_CONTENT': json.dumps(inline)}
        env.update({'XDG_' + key + '_HOME': str(state / key.lower()) for key in ['CONFIG', 'DATA', 'STATE', 'CACHE']})
        return env

    def command(args, env):
        result = subprocess.run(['/opt/opencode', *args], cwd=project, env=env,
                                capture_output=True, text=True, timeout=40)
        if result.returncode:
            raise AssertionError((result.stdout + result.stderr)[-5000:])
        return result.stdout

    first_env = environment('initial')
    sources = json.loads(command(['debug', 'config', '--standalone'], first_env))
    assert any(entry.get('info', {}).get('instructions') == ['CLAUDE.md', 'policy/*.md'] for entry in sources)
    events = [json.loads(line) for line in command(['run', '--standalone', '--format', 'json', 'Review the fixture'], first_env).splitlines() if line]
    assert not Path('/tmp/reviewrelay-executed').exists(), 'Agent permissions overrode the inspection sandbox'
    assert not any(event['type'] == 'error' for event in events), events
    text = next(event for event in events if event['type'] == 'text')
    session = text['sessionID']
    assert text['part']['text'] == 'Native review fixture'
    available={tool['function']['name'] for request in requests for tool in request.get('tools',[])}
    assert 'read' in available, f'The inspection agent has no read tool: {available}'
    inspection_requests = [request for request in requests if any(tool.get('function',{}).get('name') == 'read' for tool in request.get('tools',[]))]
    assert inspection_requests[0].get('reasoning_effort') == 'high', 'The configured primary reasoning level did not reach the model request'
    prompt = json.dumps(requests)
    assert 'Trusted native CLAUDE instruction sentinel' in prompt
    assert 'Trusted custom glob sentinel' in prompt
    exported = command(['session', 'export', '--standalone', session], first_env)
    archive = root / 'session.json'
    archive.write_text(exported)
    next_env = environment('continued','fallback')
    imported = command(['session', 'import', '--standalone', str(archive), '--directory', str(project)], next_env)
    assert session in imported
    checkpoint_inputs = {
        'reviewrelay-review.diff': '',
        'reviewrelay-publication.diff': '+Publication coverage sentinel\n',
        'reviewrelay-checkpoint.json': json.dumps({
            'report': 'Prior report evidence sentinel',
            'changedPaths': ['supporting/config.txt'],
        }),
    }
    for name, content in checkpoint_inputs.items():
        path = project / name
        path.write_text(content)
        checkpoint_reads.append(path)
    continuation_prompt = Path('/output/continuation-prompt.txt').read_text()
    continued = [json.loads(line) for line in command(
        ['run', '--standalone', '--format', 'json', '--session', session, continuation_prompt],
        next_env,
    ).splitlines() if line]
    assert not any(event['type'] == 'error' for event in continued), continued
    assert next(event for event in continued if event['type'] == 'text')['sessionID'] == session
    continued_request = next(request for request in reversed(requests) if any(tool.get('function',{}).get('name') == 'read' for tool in request.get('tools',[])))
    assert continued_request['model'] == 'deepseek/deepseek-v4.1-flash-1017', continued_request['model']
    assert continued_request.get('reasoning',{}).get('effort') == 'high', 'The configured fallback reasoning level did not reach the model request'
    assert 'Native review fixture' in json.dumps(continued_request), 'continuation lost its earlier assistant response'
    messages = continued_request['messages']
    user_messages = json.dumps([message for message in messages if message['role'] == 'user'])
    for requirement in ['complete publication scope', 'current snapshot', 'primary diff is empty',
                        'retain still-valid findings', 'remove fixed or out-of-scope findings',
                        'newly introduced defects', 'current head paths and line numbers']:
        assert requirement in user_messages, f'Missing continuation instruction: {requirement}'
    tool_results = json.dumps([message for message in messages if message['role'] == 'tool'])
    for expected in [*checkpoint_inputs, 'Publication coverage sentinel', 'Prior report evidence sentinel']:
        assert expected in tool_results, f'OpenCode did not read checkpoint input: {expected}'
    assert not checkpoint_reads
    archive.write_text(command(['session', 'export', '--standalone', session], next_env))
    project_config['provider']['opencode-go']['models'] = {'deepseek-v4.1-flash': {'options': {'reasoningEffort': 'medium'}}}
    (project / 'opencode.jsonc').write_text('// Native project reasoning override\n' + json.dumps(project_config))
    overridden_env = environment('project-override')
    command(['session', 'import', '--standalone', str(archive), '--directory', str(project)], overridden_env)
    command(['run', '--standalone', '--format', 'json', '--session', session, 'Continue using the project configuration'], overridden_env)
    overridden_request = next(request for request in reversed(requests) if any(tool.get('function',{}).get('name') == 'read' for tool in request.get('tools',[])))
    assert overridden_request['model'] == 'deepseek-v4.1-flash'
    assert overridden_request.get('reasoning_effort') == 'medium', 'The native project setting did not override the bundled default'
server.shutdown()
print('Native OpenCode: explicit CLAUDE/glob instructions, session export/import and continuation passed with a local model stub.')
