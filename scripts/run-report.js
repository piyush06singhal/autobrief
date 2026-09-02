const { runWeeklyReport, closePool } = require('../src/jobs/weeklyReport');
const { assertConfig } = require('../src/config/validateConfig');
const { describeError } = require('../src/utils/describeError');
const logger = require('../src/utils/logger');

assertConfig();

runWeeklyReport()
    .then((result) => {
        if (result.skipped) {
            logger.info('Manual report run skipped — another run was already in progress');
            return;
        }
        logger.info('Manual report run complete', { filename: result.filename, emailResult: result.emailResult });
    })
    .catch((err) => {
        logger.error('Manual report run failed', { error: describeError(err) });
        process.exitCode = 1;
    })
    .finally(() => closePool());
