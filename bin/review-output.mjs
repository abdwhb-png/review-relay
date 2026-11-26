const limit = 65536;
const escape = (value) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function analysisDetails(execution, reused) {
    if (reused)
        return `OpenCode analysis reused from run ${reused.runId}, attempt ${reused.attempt}, artifact ${reused.artifactId}. No OpenCode invocation in this request.`;
    if (!execution) return 'OpenCode measurements: unavailable.';
    const models = execution.models?.length ? execution.models.join(', ') : 'unavailable';
    const count = (value) => (Number.isFinite(value) && value >= 0 ? String(value) : 'unavailable');
    const tokens = execution.tokens;
    return `- OpenCode route: ${escape(execution.provider)}
- Model: ${escape(models)}
- Pass duration including retries: ${execution.seconds.toFixed(1)}s
- Tokens: ${count(tokens?.input)} input / ${count(tokens?.output)} output / ${count(tokens?.reasoning)} reasoning
- Cache: ${count(tokens?.cache?.read)} read / ${count(tokens?.cache?.write)} write
- Source: run ${execution.runId}, attempt ${execution.attempt}

Counters cover the successful OpenCode attempt; failed attempts and imported history are excluded. Cache counters remain separate. No cross-engine token total is calculated.`;
}

export function composeReviewOutput(
    body,
    marker,
    publication,
    config,
    { repository, createdAt, now },
) {
    if (typeof publication.analysisReport !== 'string' || !publication.analysisReport.trim())
        throw new Error('Missing verified analysis report for publication.');
    const source = publication.analysisSource;
    if (
        !/^[1-9][0-9]*$/.test(String(source?.runId)) ||
        (source.artifactId !== null && !/^[1-9][0-9]*$/.test(String(source.artifactId)))
    )
        throw new Error('Invalid analysis artifact reference.');
    const url = `https://github.com/${repository}/actions/runs/${source.runId}${source.artifactId ? `/artifacts/${source.artifactId}` : '#artifacts'}`;
    let details = '';
    if (config.includePipelineDetails) {
        const start = Date.parse(createdAt);
        const elapsed =
            Number.isFinite(start) && now >= start
                ? `${((now - start) / 1000).toFixed(1)}s`
                : 'unavailable';
        details = `\n\n<details>\n<summary>ReviewRelay pipeline details</summary>\n\n${analysisDetails(publication.execution?.analysis, publication.reusedAnalysis)}\n\nPR-Agent statistics belong to the native Agent run details section, when enabled. Its counters do not cover OpenCode.\n\nSynthesis pass duration (including retries): ${publication.execution?.synthesis ? `${publication.execution.synthesis.seconds.toFixed(1)}s` : 'unavailable'}.\n\nElapsed from run creation to publication preparation: ${elapsed} (includes job queues and retry waits).\n\n</details>`;
    }
    const suffix = `${details}\n\n${marker}`;
    const render = (report) => `${body}${report}${suffix}`;
    let report = '';
    if (config.includeAnalysisReport) {
        const wrap = (text) =>
            `\n\n<details>\n<summary>OpenCode analysis report</summary>\n\n${text}\n\n[Complete analysis artifact](${url})\n\n</details>`;
        report = wrap(publication.analysisReport.replace(/<\/?details\b[^>]*>/gi, escape));
        if (Buffer.byteLength(render(report)) > limit) {
            const points = Array.from(publication.analysisReport);
            const excerpt = (length) =>
                wrap(
                    `Report excerpt — shortened to fit GitHub's publication limit.\n\n<pre>${escape(points.slice(0, length).join(''))}</pre>`,
                );
            if (Buffer.byteLength(render(excerpt(0))) > limit)
                throw new Error('The final review exceeds the GitHub publication limit.');
            let low = 0,
                high = points.length;
            while (low < high) {
                const mid = Math.ceil((low + high) / 2);
                if (Buffer.byteLength(render(excerpt(mid))) <= limit) low = mid;
                else high = mid - 1;
            }
            report = excerpt(low);
        }
    }
    const result = render(report);
    if (Buffer.byteLength(result) > limit)
        throw new Error('The final review exceeds the GitHub publication limit.');
    return result;
}
