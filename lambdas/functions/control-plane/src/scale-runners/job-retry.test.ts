import { publishMessage } from '../aws/sqs';
import { publishRetryMessage, checkAndRetryJob } from './job-retry';
import { ActionRequestMessage, ActionRequestMessageRetry } from './scale-up';
import { createSingleMetric } from '@aws-github-runner/aws-powertools-util';
import { Octokit } from '@octokit/rest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAppInstallationClient } from '../github/client';

vi.mock('../aws/sqs', () => ({
  publishMessage: vi.fn(),
}));

vi.mock('@aws-github-runner/aws-powertools-util', () => {
  return {
    createSingleMetric: vi.fn(() => {
      return {
        addMetadata: vi.fn(),
      };
    }),
    createChildLogger: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    addPersistentContextToChildLogger: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('../github/client', () => ({
  createAppAuthClient: vi.fn().mockResolvedValue({}),
  createAppInstallationClient: vi.fn().mockResolvedValue({
    actions: {
      getJobForWorkflowRun: vi.fn(),
    },
  }),
  getGitHubEnterpriseApiUrl: vi.fn().mockReturnValue({
    ghesApiUrl: 'https://api.github.com',
    ghesBaseUrl: 'https://github.com'
  }),
}));

vi.mock('@octokit/rest', () => {
  const mockOctokit = {
    actions: {
      getJobForWorkflowRun: vi.fn(),
    },
  };

  const MockOctokit = vi.fn().mockImplementation(() => mockOctokit);

  return {
    Octokit: MockOctokit,
  };
});

const mockCreateAppInstallationClient = vi.mocked(createAppInstallationClient);
const mockPublishMessage = vi.mocked(publishMessage);
const mockCreateSingleMetric = vi.mocked(createSingleMetric);

const cleanEnv = process.env;

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...cleanEnv };

  mockCreateAppInstallationClient.mockImplementation(async () => {
    return {
      actions: {
        getJobForWorkflowRun: vi.fn().mockImplementation(() => ({
          data: {
            status: 'queued',
          },
          headers: {},
        })),
      },
    } as unknown as Octokit;
  });
});

describe('Test job retry publish message', () => {
  const data = [
    {
      description: 'publish a message if retry is enabled and counter is undefined.',
      input: { enable: true, retryCounter: undefined, maxAttempts: 2, delayInSeconds: 10 },
      output: { published: true, newRetryCounter: 0, delay: 10 },
    },
    {
      description: 'publish a message if retry is enabled and counter is 1 and is below max attempts.',
      input: { enable: true, retryCounter: 0, maxAttempts: 2, delayInSeconds: 10 },
      output: { published: true, newRetryCounter: 1, delay: 20 },
    },
    {
      description: 'publish a message with delay exceeding sqs max.',
      input: { enable: true, retryCounter: 0, maxAttempts: 2, delayInSeconds: 1000 },
      output: { published: true, newRetryCounter: 1, delay: 900 },
    },
    {
      description: 'NOT publish a message if retry is enabled and counter is 1 and is NOT below max attempts.',
      input: { enable: true, retryCounter: 0, delayInSeconds: 1000 },
      output: { published: false },
    },
    {
      description: 'NOT publish a message if retry is NOT enabled.',
      input: { enable: false },
      output: { published: false },
    },
  ];

  it.each(data)(`should $description`, async ({ input, output }) => {
    const message: ActionRequestMessage = {
      eventType: 'workflow_job',
      id: 0,
      installationId: 0,
      repositoryName: 'test',
      repositoryOwner: 'github-aws-runners',
      repoOwnerType: 'Organization',
      retryCounter: input.retryCounter,
    };
    const jobRetryConfig = {
      enable: input.enable,
      maxAttempts: input.maxAttempts,
      delayInSeconds: input.delayInSeconds,
      delayBackoff: 2,
      queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789/webhook_events_workflow_job_queue',
    };
    process.env.JOB_RETRY_CONFIG = JSON.stringify(jobRetryConfig);

    // act
    await publishRetryMessage(message);

    // assert
    if (output.published) {
      expect(mockPublishMessage).toHaveBeenCalledWith(
        JSON.stringify({
          ...message,
          retryCounter: output.newRetryCounter,
        }),
        jobRetryConfig.queueUrl,
        output.delay,
      );
    } else {
      expect(mockPublishMessage).not.toHaveBeenCalled();
    }
  });

  it(`should not ignore and not throw if no retry configuration is set. `, async () => {
    // setup
    const message: ActionRequestMessage = {
      eventType: 'workflow_job',
      id: 0,
      installationId: 0,
      repositoryName: 'test',
      repositoryOwner: 'github-aws-runners',
      repoOwnerType: 'Organization',
    };

    // act
    await expect(publishRetryMessage(message)).resolves.not.toThrow();
    expect(mockPublishMessage).not.toHaveBeenCalled();
  });
});

describe(`Test job retry check`, () => {
  it(`should publish a message for retry if retry is enabled and counter is below max attempts.`, async () => {
    mockCreateAppInstallationClient.mockResolvedValueOnce({
      actions: {
        getJobForWorkflowRun: vi.fn().mockReturnValue({
          data: { status: 'queued' },
          headers: {},
        }),
      },
    } as unknown as Octokit);

    const message: ActionRequestMessageRetry = {
      eventType: 'workflow_job',
      id: 0,
      installationId: 0,
      repositoryName: 'test',
      repositoryOwner: 'github-aws-runners',
      repoOwnerType: 'Organization',
      retryCounter: 0,
    };
    process.env.ENABLE_ORGANIZATION_RUNNERS = 'true';
    process.env.RUNNER_NAME_PREFIX = 'test';
    process.env.JOB_QUEUE_SCALE_UP_URL =
      'https://sqs.eu-west-1.amazonaws.com/123456789/webhook_events_workflow_job_queue';

    const mockGhAppClient = {} as Octokit;

    // act
    await checkAndRetryJob(mockGhAppClient, message);

    // assert
    expect(mockPublishMessage).toHaveBeenCalledWith(
      JSON.stringify({
        ...message,
      }),
      'https://sqs.eu-west-1.amazonaws.com/123456789/webhook_events_workflow_job_queue',
    );
    expect(mockCreateSingleMetric).not.toHaveBeenCalled();
    expect(mockCreateAppInstallationClient).toHaveBeenCalledWith(
      mockGhAppClient,
      true,
      'github-aws-runners'
    );
  });

  it(`should publish a message for retry if retry is enabled
      and counter is below max attempts with metrics.`, async () => {
    mockCreateAppInstallationClient.mockResolvedValueOnce({
      actions: {
        getJobForWorkflowRun: vi.fn().mockReturnValue({
          data: { status: 'queued' },
          headers: {},
        }),
      },
    } as unknown as Octokit);

    const message: ActionRequestMessageRetry = {
      eventType: 'workflow_job',
      id: 0,
      installationId: 0,
      repositoryName: 'test',
      repositoryOwner: 'github-aws-runners',
      repoOwnerType: 'Organization',
      retryCounter: 1,
    };

    process.env.ENABLE_ORGANIZATION_RUNNERS = 'true';
    process.env.ENVIRONMENT = 'test';
    process.env.RUNNER_NAME_PREFIX = 'test';
    process.env.ENABLE_METRIC_JOB_RETRY = 'true';
    process.env.JOB_QUEUE_SCALE_UP_URL =
      'https://sqs.eu-west-1.amazonaws.com/123456789/webhook_events_workflow_job_queue';

    const mockGhAppClient = {} as Octokit;

    // act
    await checkAndRetryJob(mockGhAppClient, message);

    // assert
    expect(mockPublishMessage).toHaveBeenCalledWith(
      JSON.stringify({
        ...message,
      }),
      'https://sqs.eu-west-1.amazonaws.com/123456789/webhook_events_workflow_job_queue',
    );
    expect(mockCreateSingleMetric).toHaveBeenCalled();
    expect(mockCreateSingleMetric).toHaveBeenCalledWith('RetryJob', 'Count', 1, {
      Environment: 'test',
      RetryCount: '1',
    });
  });

  it(`should not publish a message for retry when the job is running.`, async () => {
    mockCreateAppInstallationClient.mockResolvedValueOnce({
      actions: {
        getJobForWorkflowRun: vi.fn().mockReturnValue({
          data: { status: 'running' },
          headers: {},
        }),
      },
    } as unknown as Octokit);

    const message: ActionRequestMessageRetry = {
      eventType: 'workflow_job',
      id: 0,
      installationId: 0,
      repositoryName: 'test',
      repositoryOwner: 'github-aws-runners',
      repoOwnerType: 'Organization',
      retryCounter: 0,
    };
    process.env.ENABLE_ORGANIZATION_RUNNERS = 'true';
    process.env.RUNNER_NAME_PREFIX = 'test';
    process.env.JOB_QUEUE_SCALE_UP_URL =
      'https://sqs.eu-west-1.amazonaws.com/123456789/webhook_events_workflow_job_queue';

    const mockGhAppClient = {} as Octokit;

    // act
    await checkAndRetryJob(mockGhAppClient, message);

    // assert
    expect(mockPublishMessage).not.toHaveBeenCalled();
  });

  it(`should not publish a message for retry if job is no longer queued.`, async () => {
    // Set up mock for a completed job
    mockCreateAppInstallationClient.mockResolvedValueOnce({
      actions: {
        getJobForWorkflowRun: vi.fn().mockReturnValue({
          data: { status: 'completed' },
          headers: {},
        }),
      },
    } as unknown as Octokit);

    const message: ActionRequestMessageRetry = {
      eventType: 'workflow_job',
      id: 0,
      installationId: 0,
      repositoryName: 'test',
      repositoryOwner: 'github-aws-runners',
      repoOwnerType: 'Organization',
      retryCounter: 0,
    };
    process.env.ENABLE_ORGANIZATION_RUNNERS = 'false';

    const mockGhAppClient = {} as Octokit;

    // act
    await checkAndRetryJob(mockGhAppClient, message);

    // assert
    expect(mockPublishMessage).not.toHaveBeenCalled();
  });
});
