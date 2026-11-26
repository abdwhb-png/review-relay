"""Prepare and archive native PR-Agent output separately from publication."""
import asyncio
import json
import os
import re
import tomllib
from pathlib import Path
import sys

from pr_agent.algo.comment_identity import (
    PRReviewIdentity,
    add_pr_review_identity,
    format_pr_review_header,
)
from pr_agent.algo.file_filter import filter_ignored
from pr_agent.git_providers.github_provider import GithubProvider
from pr_agent.git_providers.git_provider import IncrementalPR
from pr_agent.git_providers.utils import apply_repo_settings
from pr_agent.config_loader import get_settings
from pr_agent.algo.setting_utils import normalize_setting_list
from pr_agent.algo.repo_context import _sibling_repo_context_entries


class ReviewRelayGithubProvider(GithubProvider):
    def __init__(self, pr_url=None):
        super().__init__(pr_url)
        self._reviewrelay_settings = b''
        if pr_url and os.environ.get('REVIEW_REPO_SETTINGS_PRESENT') != 'false':
            path = os.environ.get('REVIEW_PR_AGENT_CONFIG_PATH', '.pr_agent.toml')
            snapshot = self._resolve_settings_snapshot(os.environ['BASE_SHA'])
            contents = self.get_repo_settings_contents([path], snapshot[0])
            if path not in contents:
                raise RuntimeError('Selected native repository settings are unavailable at the frozen base')
            from pr_agent.custom_merge_loader import validate_file_security
            validate_file_security(tomllib.loads(contents[path].decode()), path)
            self._reviewrelay_settings = contents[path]
            self._repo_settings_snapshot = snapshot
        self._repo_settings_acquired = True

    def get_repo_settings(self):
        return self._reviewrelay_settings

    def get_previous_review(self, *, full, incremental):
        marker = os.environ.get('REVIEW_STREAM_MARKER', '')
        candidates = []
        for comment in self.pr.get_issue_comments():
            first_line = (comment.body or '').split('\n', 1)[0]
            if (first_line == marker if marker else not first_line.startswith('<!-- reviewrelay:stream:')):
                candidates.append(comment)
        if not candidates:
            return None
        self.comments = candidates
        return super().get_previous_review(full=full, incremental=incremental)


from pr_agent.git_providers import _GIT_PROVIDERS
_GIT_PROVIDERS['github'] = ReviewRelayGithubProvider


url = f'https://github.com/{os.environ["GITHUB_REPOSITORY"]}/pull/{os.environ["PR_NUMBER"]}'
# The dedicated native string override survives Dynaconf coercion of all-digit SHAs.
os.environ['PR_AGENT_CONFIG_BRANCH'] = os.environ['BASE_SHA']
get_settings().set('config.config_branch', os.environ['BASE_SHA'])
os.environ['CONFIG__REPO_CONTEXT_FROM_DEFAULT_BRANCH'] = 'false'
get_settings().set('config.repo_context_from_default_branch', False)
if os.environ.get('REVIEW_REPO_SETTINGS_PRESENT') == 'false':
    # Native missing-file fallback reads a moving default branch; absence is frozen too.
    os.environ['CONFIG__USE_REPO_SETTINGS_FILE'] = 'false'
    get_settings().set('config.use_repo_settings_file', False)
apply_repo_settings(url)
context_files = normalize_setting_list(get_settings().config.repo_context_files)
if _sibling_repo_context_entries(context_files):
    raise RuntimeError('Instruction context must stay in the current frozen repository')
for path in json.loads(os.environ.get('REVIEW_INSTRUCTION_PATHS', '[]')):
    if path not in context_files:
        context_files.append(path)
os.environ['CONFIG__REPO_CONTEXT_FILES'] = json.dumps(context_files)
get_settings().set('config.repo_context_files', context_files)
excluded = json.loads(os.environ.get('REVIEW_EXCLUDED_REGEX', '[]'))
ignored = normalize_setting_list(get_settings().ignore.regex)
os.environ['IGNORE__REGEX'] = json.dumps(list(dict.fromkeys([*ignored, *excluded])))
get_settings().set('ignore.regex', json.loads(os.environ['IGNORE__REGEX']))
provider = ReviewRelayGithubProvider(url)
if (provider.pr.base.sha, provider.pr.head.sha) != (
    os.environ['BASE_SHA'], os.environ['HEAD_SHA']
):
    raise RuntimeError('PR revision changed before native review preparation')

if sys.argv[1] == 'publish-suggestions':
    from pr_agent.tools.pr_code_suggestions import PRCodeSuggestions, get_committable_code_suggestions

    class InferenceDisabled:
        async def chat_completion(self, *args, **kwargs):
            raise RuntimeError('Inference is forbidden during publication')

    data = json.loads(Path('/output/suggestions.json').read_text())
    if not isinstance(data.get('code_suggestions'), list):
        raise RuntimeError('Invalid native suggestions artifact')
    if not isinstance(data.get('publication_settings'), dict):
        raise RuntimeError('Missing native suggestion publication settings')
    for key, value in data['publication_settings'].items():
        get_settings().set('pr_code_suggestions.' + key, value)
    marker = os.environ.get('REVIEW_PUBLICATION_MARKER', '')
    if not re.fullmatch(r'<!-- reviewrelay:[a-f0-9]{64} -->', marker):
        raise RuntimeError('Missing verified publication identity')
    comments = [*provider.pr.get_review_comments(), *provider.pr.get_issue_comments()]
    existing = [comment.body for comment in comments if comment.user.login == 'github-actions[bot]']
    pending = []
    identities = []
    for index, suggestion in enumerate(data['code_suggestions']):
        identity = marker.replace(' -->', f':{index} -->')
        identities.append(identity)
        if any(identity in body for body in existing):
            continue
        suggestion['suggestion_content'] = f"{suggestion['suggestion_content']}\n{identity}"
        pending.append(suggestion)
    data['code_suggestions'] = pending
    get_settings().set('config.publish_output', True)
    if data['code_suggestions']:
        tool = PRCodeSuggestions(url, cli_mode=True, ai_handler=InferenceDisabled)
        if get_committable_code_suggestions():
            asyncio.run(tool.push_inline_code_suggestions(data))
            if not getattr(tool, '_output_published', False):
                raise RuntimeError('PR-Agent did not confirm suggestion publication')
        else:
            body = tool.generate_summarized_suggestions(data)
            if not body or not provider.publish_comment(body):
                raise RuntimeError('PR-Agent did not confirm summarized suggestions')
    comments = [*provider.pr.get_review_comments(), *provider.pr.get_issue_comments()]
    confirmed = [comment.body for comment in comments if comment.user.login == 'github-actions[bot]']
    if any(not any(identity in body for body in confirmed) for identity in identities):
        raise RuntimeError('Suggestion publication is partial; retry to reconcile remaining suggestions')
    print(json.dumps({'published': len(identities), 'reused': len(identities) - len(pending)}))
    sys.exit(0)

expected = json.loads(os.environ.get('REVIEW_SCOPE', 'null'))
incremental = IncrementalPR(
    expected['incremental'] if expected else os.environ.get('REVIEW_FULL') != 'true'
)
provider.get_incremental_commits(incremental)
files = filter_ignored(provider.get_files())
scope = {
    'incremental': incremental.is_incremental,
    'start': incremental.last_seen_commit_sha if incremental.is_incremental else provider.pr.base.sha,
    'first': incremental.first_new_commit_sha if incremental.is_incremental else None,
    'paths': sorted({
        name for file in files
        for name in [file.filename, getattr(file, 'previous_filename', None)] if name
    }),
}
if expected is not None and scope != expected:
    raise RuntimeError('Native review scope changed during this run')
if sys.argv[1] == 'generate':
    section = 'pr_code_suggestions' if os.environ['REVIEW_COMMAND'] == 'improve' else 'pr_reviewer'
    native = get_settings().get(section + '.extra_instructions', '')
    os.environ[section.upper() + '__EXTRA_INSTRUCTIONS'] = '\n\n'.join(filter(None, [native, os.environ.get('REVIEW_EXTRA_INSTRUCTIONS', '')]))
    publication_settings = get_settings().pr_code_suggestions.to_dict() if section == 'pr_code_suggestions' else None
    if section == 'pr_reviewer':
        from pr_agent.agent.pr_agent import command2class
        from pr_agent.tools.pr_reviewer import PRReviewer

        class ArchivedPRReviewer(PRReviewer):
            async def run(self):
                await super().run()
                # The native CLI discards its request settings on exit. Capture its
                # complete dry-run output here while usage and timing still exist.
                body = get_settings().get('data', {}).get('artifact')
                if not isinstance(body, str) or not body.strip():
                    raise RuntimeError('Missing native dry-run review output')
                identity = PRReviewIdentity.INCREMENTAL.value if self.incremental.is_incremental else PRReviewIdentity.REGULAR.value
                body = add_pr_review_identity(body, identity, self.git_provider)
                anchor = add_pr_review_identity(
                    format_pr_review_header(incremental=self.incremental.is_incremental), identity, self.git_provider
                )
                from pr_agent.algo.run_details import get_run_details
                details = get_run_details()
                models = list(details.models_used or ([details.model_used] if details.model_used else [])) if details else []
                Path('/output/rendered.json').write_text(json.dumps({'body': body, 'anchor': anchor, 'models': models}))

        command2class['review'] = ArchivedPRReviewer
    from pr_agent.cli import run
    result = run(inargs=sys.argv[2:])
    if result in (None, 0) and publication_settings is not None:
        output = Path('/output/improve.json')
        data = json.loads(output.read_text())
        data['publication_settings'] = publication_settings
        output.write_text(json.dumps(data))
    sys.exit(result)
elif sys.argv[1] == 'scope':
    print(json.dumps(scope))
else:
    raise RuntimeError('Unknown native review operation')
