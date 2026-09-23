import { defineSchedule } from 'eve/schedules';

import { refreshRecentPullRequests } from '../lib/github/recent';

/**
 * Walks GitHub for the landing page's example row once an hour, so no reader
 * ever does. The handler form, not the markdown one: markdown starts an agent
 * session on every run, and this needs no model at all.
 *
 * Off the hour because the anonymous GitHub budget is counted per address, and
 * the addresses a function calls out from are shared with every other hourly
 * job that fires on the hour.
 */
export default defineSchedule({
  cron: '23 * * * *',
  async run() {
    await refreshRecentPullRequests();
  },
});
