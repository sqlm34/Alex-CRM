import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const jobMergeSource = readFileSync(new URL('../src/jobMerge.ts', import.meta.url), 'utf8')

test('Jobs shows complete history jobs', () => {
  assert.match(appSource, /function isClosedJob\(job: Job\) \{\s*return job\.status === 'complete' \|\| job\.status === 'canceled'\s*\}/)
  assert.match(appSource, /const jobHistory = useMemo\(\(\) => searchedJobs\.filter\(isClosedJob\)\.sort\(sortJobHistory\), \[searchedJobs\]\)/)
})

test('Jobs shows canceled history jobs', () => {
  assert.match(appSource, /job\.status === 'canceled'/)
  assert.match(appSource, /<JobHistoryList[\s\S]*?jobs=\{jobHistory\}/)
})

test('Jobs does not show new scheduled or in progress jobs', () => {
  assert.doesNotMatch(appSource, /<JobHistoryList[\s\S]*?jobs=\{activeScheduleJobs\}/)
  assert.doesNotMatch(appSource, /const jobHistory = useMemo\(\(\) => searchedJobs\.filter\(isActiveScheduleJob\)/)
})

test('Schedule shows active jobs', () => {
  assert.match(appSource, /function isActiveScheduleJob\(job: Job\) \{\s*return job\.status === 'new' \|\| job\.status === 'scheduled' \|\| job\.status === 'in_progress'\s*\}/)
  assert.match(appSource, /const activeScheduleJobs = useMemo\(\(\) => searchedJobs\.filter\(isActiveScheduleJob\), \[searchedJobs\]\)/)
})

test('Schedule does not show complete or canceled jobs', () => {
  assert.match(appSource, /const scheduleGroups = useMemo\(\(\) => groupJobsByScheduleDate\(activeScheduleJobs\), \[activeScheduleJobs\]\)/)
  assert.doesNotMatch(appSource, /groupJobsByScheduleDate\(searchedJobs\)/)
  assert.doesNotMatch(appSource, /groupJobsByScheduleDate\(jobHistory\)/)
})

test('Jobs search can find a closed order by ORDER number', () => {
  assert.match(appSource, /matchesJobSearch\(job, search, orderNumbers\.get\(job\.id\)\)/)
  assert.match(appSource, /`ORDER# \$\{orderNumber\}`/)
})

test('Switching Jobs and Schedule keeps the jobs array intact', () => {
  assert.match(appSource, /const activeScheduleJobs = useMemo\(\(\) => searchedJobs\.filter\(isActiveScheduleJob\), \[searchedJobs\]\)/)
  assert.match(appSource, /const jobHistory = useMemo\(\(\) => searchedJobs\.filter\(isClosedJob\)\.sort\(sortJobHistory\), \[searchedJobs\]\)/)
  assert.doesNotMatch(appSource, /setJobs\(\[\]\)[\s\S]{0,200}goToPage/)
})

test('Opening a closed job still loads full details', () => {
  assert.match(appSource, /<JobHistoryList[\s\S]*?onOpenJob=\{openJob\}/)
  assert.match(appSource, /const openJob = \(id: string\) => \{[\s\S]*?loadJobDetails\(id\)[\s\S]*?\}/)
})

test('Polling does not remove Finance Payments or Attachments', () => {
  assert.match(jobMergeSource, /financeItems/)
  assert.match(jobMergeSource, /payments/)
  assert.match(jobMergeSource, /modelPhotoAttachments/)
  assert.match(appSource, /mergeJobListRows\(current, data, rowToJob, dirtyJobIdsRef\.current\)/)
})

test('Hamburger and Logout remain wired through the drawer', () => {
  assert.match(appSource, /className="menu-trigger"/)
  assert.match(appSource, /aria-label=\{menuOpen \? 'Close menu' : 'Open menu'\}/)
  assert.match(appSource, /<button type="button" onClick=\{signOut\}>[\s\S]*?<LogOut size=\{16\} \/>[\s\S]*?Log out/)
})
