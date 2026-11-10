const REPO = 'codeongit/job-tracker';
const WORKFLOW = '.github/workflows/ci.yml';
const RUNNING = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

function matches(run, commit) {
  return (
    run?.head_sha === commit &&
    run.head_branch === 'main' &&
    run.event === 'push' &&
    run.path === WORKFLOW
  );
}

function checkedRun(run, commit) {
  if (
    !matches(run, commit) ||
    !positiveInteger(run.id) ||
    !positiveInteger(run.workflow_id) ||
    !positiveInteger(run.run_attempt) ||
    !Number.isFinite(Date.parse(run.created_at))
  )
    throw new Error('main CI 运行身份或版本无效。');
  return run;
}

function checkedList(result, field) {
  if (
    !Number.isSafeInteger(result?.total_count) ||
    result.total_count < 0 ||
    !Array.isArray(result[field]) ||
    result.total_count !== result[field].length
  )
    throw new Error('main CI 查询结果无效或不完整，不能确认成功。');
  return result[field];
}

function describe(run) {
  return {
    runId: run.id,
    attempt: run.run_attempt,
    url: `https://github.com/${REPO}/actions/runs/${run.id}`,
    conclusion: run.conclusion,
  };
}

function readJobs(api, run, commit) {
  const jobs = checkedList(
    api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`),
    'jobs',
  );
  if (
    jobs.some(
      (job) =>
        !positiveInteger(job.id) ||
        job.run_id !== run.id ||
        job.run_attempt !== run.run_attempt ||
        job.head_sha !== commit ||
        typeof job.name !== 'string',
    )
  )
    throw new Error('main CI 作业与当前运行版本不一致。');
  return jobs;
}

function failedJobs(jobs, run) {
  return jobs
    .filter((job) => job.status === 'completed' && job.conclusion !== 'success')
    .map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      url: `https://github.com/${REPO}/actions/runs/${run.id}/job/${job.id}`,
      steps: (job.steps || [])
        .filter((step) => step.conclusion && !['success', 'skipped'].includes(step.conclusion))
        .map((step) => step.name),
    }));
}

// Only observes the merge commit's existing push run. No rerun, cancel or merge writes.
export async function waitForMergedCI({ commit, api, waitSeconds, sleep, now }) {
  const end = now() + waitSeconds * 1000;
  let observed = {};
  try {
    while (true) {
      const runs = checkedList(
        api(`actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${commit}&per_page=100`),
        'workflow_runs',
      )
        .filter((run) => matches(run, commit))
        .map((run) => checkedRun(run, commit))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
      const run = runs[0];
      observed = run ? describe(run) : {};
      let reason = '尚未发现合并提交对应的 main push CI。';
      if (run) {
        reason = 'main CI 尚未完成。';
        if (run.status === 'completed') {
          if (typeof run.conclusion !== 'string' || !run.conclusion)
            throw new Error('main CI 已结束但缺少结论。');
          if (run.conclusion !== 'success') {
            let details;
            try {
              details = { failedJobs: failedJobs(readJobs(api, run, commit), run) };
            } catch {
              details = { detailsUnavailable: true };
            }
            return {
              status: 'failed',
              commit,
              ...observed,
              ...details,
              message: `main CI 未通过：${run.conclusion}。`,
            };
          }
          const jobs = readJobs(api, run, commit);
          // A rerun can start while jobs are being read. Never use the older green attempt.
          const latest = checkedRun(api(`actions/runs/${run.id}`), commit);
          if (latest.id !== run.id || latest.workflow_id !== run.workflow_id)
            throw new Error('main CI 运行身份在核对期间发生变化。');
          if (
            latest.run_attempt !== run.run_attempt ||
            latest.status !== run.status ||
            latest.conclusion !== run.conclusion
          ) {
            reason = 'main CI 在核对期间重跑或改变状态，需重新核对。';
            observed = describe(latest);
          } else if (!jobs.some((job) => job.name === 'verify')) {
            throw new Error('main CI 缺少 verify 作业，不能确认成功。');
          } else if (
            jobs.some((job) => job.status !== 'completed' || job.conclusion !== 'success')
          ) {
            return {
              status: 'failed',
              commit,
              ...observed,
              failedJobs: failedJobs(jobs, run),
              message: 'main CI 作业没有全部成功。',
            };
          } else {
            return {
              status: 'passed',
              commit,
              ...observed,
              message: '合并提交的 main CI/verify 已通过。',
            };
          }
        } else if (!RUNNING.has(run.status)) {
          throw new Error('main CI 返回未知运行状态。');
        }
      }
      if (now() >= end)
        return {
          status: 'pending',
          commit,
          ...observed,
          timedOut: true,
          message: `${reason}等待预算已用完，请按相同版本再次只读核对。`,
        };
      await sleep(Math.min(5000, end - now()));
    }
  } catch (error) {
    return { status: 'unconfirmed', commit, ...observed, message: error.message };
  }
}
