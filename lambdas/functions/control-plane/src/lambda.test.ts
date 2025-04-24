import { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { logger, captureLambdaHandler } from '@aws-github-runner/aws-powertools-util';
import { addMiddleware, adjustPool, scaleDownHandler, scaleUpHandler, ssmHousekeeper, jobRetryCheck } from './lambda';
import { adjust } from './pool/pool';
import ScaleError from './scale-runners/ScaleError';
import { scaleDown } from './scale-runners/scale-down';
import { ActionRequestMessage, scaleUp } from './scale-runners/scale-up';
import { cleanSSMTokens } from './scale-runners/ssm-housekeeper';
import { checkAndRetryJob } from './scale-runners/job-retry';
import { describe, it, expect, vi } from 'vitest';

vi.mock('./github/client', () => ({
  createAppAuthClient: vi.fn().mockResolvedValue({}),
  createAppInstallationClient: vi.fn().mockResolvedValue({}),
  getGitHubEnterpriseApiUrl: vi.fn()
    .mockReturnValue({ ghesApiUrl: 'https://api.github.com', ghesBaseUrl: 'https://github.com' }),
}));
vi.mock('./pool/pool');
vi.mock('./scale-runners/scale-down');
vi.mock('./scale-runners/scale-up');
vi.mock('./scale-runners/ssm-housekeeper');
vi.mock('./scale-runners/job-retry');
vi.mock('@aws-github-runner/aws-powertools-util');

const body: ActionRequestMessage = {
  eventType: 'workflow_job',
  id: 1,
  installationId: 1,
  repositoryName: 'name',
  repositoryOwner: 'owner',
  repoOwnerType: 'Organization',
};

const sqsRecord: SQSRecord = {
  attributes: {
    ApproximateFirstReceiveTimestamp: '',
    ApproximateReceiveCount: '',
    SenderId: '',
    SentTimestamp: '',
  },
  awsRegion: '',
  body: JSON.stringify(body),
  eventSource: 'aws:SQS',
  eventSourceARN: '',
  md5OfBody: '',
  messageAttributes: {},
  messageId: '',
  receiptHandle: '',
};

const sqsEvent: SQSEvent = {
  Records: [sqsRecord],
};

const context: Context = {
  awsRequestId: '1',
  callbackWaitsForEmptyEventLoop: false,
  functionName: '',
  functionVersion: '',
  getRemainingTimeInMillis: () => 0,
  invokedFunctionArn: '',
  logGroupName: '',
  logStreamName: '',
  memoryLimitInMB: '',
  done: () => {
    return;
  },
  fail: () => {
    return;
  },
  succeed: () => {
    return;
  },
};

describe('Test scale up lambda wrapper.', () => {
  it('Do not handle multiple record sets.', async () => {
    await testInvalidRecords([sqsRecord, sqsRecord]);
  });

  it('Do not handle empty record sets.', async () => {
    await testInvalidRecords([]);
  });

  it('Scale without error should resolve.', async () => {
    const mockScaleUp = vi.mocked(scaleUp);
    mockScaleUp.mockResolvedValue();
    await expect(scaleUpHandler(sqsEvent, context)).resolves.not.toThrow();
  });

  it('Non scale should resolve.', async () => {
    const error = new Error('Non scale should resolve.');
    const mockScaleUp = vi.mocked(scaleUp);
    mockScaleUp.mockRejectedValue(error);
    await expect(scaleUpHandler(sqsEvent, context)).resolves.not.toThrow();
  });

  it('Scale should be rejected', async () => {
    const error = new ScaleError('Scale should be rejected');
    const mockScaleUp = vi.mocked(scaleUp);
    mockScaleUp.mockRejectedValue(error);
    await expect(scaleUpHandler(sqsEvent, context)).rejects.toThrow(error);
  });
});

async function testInvalidRecords(sqsRecords: SQSRecord[]) {
  const mockScaleUp = vi.mocked(scaleUp);
  const logWarnSpy = vi.spyOn(logger, 'warn');
  mockScaleUp.mockResolvedValue();

  const sqsEventMultipleRecords: SQSEvent = {
    Records: sqsRecords,
  };

  await expect(scaleUpHandler(sqsEventMultipleRecords, context)).resolves.not.toThrow();

  expect(logWarnSpy).toHaveBeenCalledWith(
    expect.stringContaining(
      'Event ignored, only one record at the time can be handled, ensure the lambda batch size is set to 1.',
    ),
  );
}

describe('Test scale down lambda wrapper.', () => {
  it('Scaling down no error.', async () => {
    const mockScaleDown = vi.mocked(scaleDown);
    mockScaleDown.mockResolvedValue();
    await expect(scaleDownHandler({}, context)).resolves.not.toThrow();
  });

  it('Scaling down with error.', async () => {
    const error = new Error('Scaling down with error.');
    const mockScaleDown = vi.mocked(scaleDown);
    mockScaleDown.mockRejectedValue(error);
    await expect(scaleDownHandler({}, context)).resolves.not.toThrow();
  });
});

describe('Adjust pool.', () => {
  it('Receive message to adjust pool.', async () => {
    const mockAdjust = vi.mocked(adjust);
    mockAdjust.mockResolvedValue();
    await expect(adjustPool({ poolSize: 2 }, context)).resolves.not.toThrow();
  });

  it('Handle error for adjusting pool.', async () => {
    const mockAdjust = vi.mocked(adjust);
    const error = new Error('Handle error for adjusting pool.');
    mockAdjust.mockRejectedValue(error);
    const logErrorSpy = vi.spyOn(logger, 'error');
    await adjustPool({ poolSize: 0 }, context);
    expect(logErrorSpy).toHaveBeenCalledWith(`Handle error for adjusting pool. ${error.message}`, { error });
  });
});

describe('Test middleware', () => {
  it('Should have a working middleware', async () => {
    const mockedCaptureLambdaHandler = vi.mocked(captureLambdaHandler);
    mockedCaptureLambdaHandler.mockReturnValue({
      before: vi.fn(),
      after: vi.fn(),
      onError: vi.fn(),
    });

    expect(addMiddleware).not.toThrowError();
  });
});

describe('Test ssm housekeeper lambda wrapper.', () => {
  it('Invoke without errors.', async () => {
    const mockCleanSSMTokens = vi.mocked(cleanSSMTokens);
    mockCleanSSMTokens.mockResolvedValue();

    process.env.SSM_CLEANUP_CONFIG = JSON.stringify({
      dryRun: false,
      minimumDaysOld: 1,
      tokenPath: '/path/to/tokens/',
    });

    await expect(ssmHousekeeper({}, context)).resolves.not.toThrow();
  });

  it('Errors not throws.', async () => {
    const mockCleanSSMTokens = vi.mocked(cleanSSMTokens);
    mockCleanSSMTokens.mockRejectedValue(new Error());
    await expect(ssmHousekeeper({}, context)).resolves.not.toThrow();
  });
});

describe('Test job retry check wrapper', () => {
  it('Handle without error should resolve.', async () => {
    const mockCheckAndRetryJob = vi.mocked(checkAndRetryJob);
    mockCheckAndRetryJob.mockResolvedValue();
    await expect(jobRetryCheck(sqsEvent, context)).resolves.not.toThrow();
  });

  it('Handle with error should resolve and log only a warning.', async () => {
    const logWarnSpy = vi.spyOn(logger, 'warn');
    const mockCheckAndRetryJob = vi.mocked(checkAndRetryJob);
    const error = new Error('Error handling retry check.');
    mockCheckAndRetryJob.mockRejectedValue(error);

    await expect(jobRetryCheck(sqsEvent, context)).resolves.not.toThrow();
    expect(logWarnSpy).toHaveBeenCalledWith(`Error processing job retry: ${error.message}`, { error });
  });
});
