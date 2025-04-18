import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Octokit } from '@octokit/rest';
import * as nock from 'nock';

import {
  createAppAuthClient,
  createAppInstallationClient,
  getGitHubEnterpriseApiUrl,
} from './client';

const cleanEnv = process.env;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...cleanEnv };
  process.env.PARAMETER_GITHUB_APP_ID_NAME = '/test/app/id';
  process.env.PARAMETER_GITHUB_APP_KEY_BASE64_NAME = '/test/app/key';
  process.env.GITHUB_APP_ID = '1337';
  process.env.GITHUB_APP_KEY_BASE64 = Buffer.from('test-key', 'utf-8').toString('base64');
  process.env.RUNNER_OWNER = 'test-org';
  nock.disableNetConnect();
});

// Mock getParameter to return test values
vi.mock('@aws-github-runner/aws-ssm-util', () => ({
  getParameter: vi.fn((name: string) => {
    if (name === process.env.PARAMETER_GITHUB_APP_ID_NAME) return Promise.resolve('1337');
    if (name === process.env.PARAMETER_GITHUB_APP_KEY_BASE64_NAME) {
      return Promise.resolve(process.env.GITHUB_APP_KEY_BASE64);
    }
    return Promise.resolve('');
  }),
}));

describe('client.ts', () => {
  it('getGitHubEnterpriseApiUrl returns correct URLs', () => {
    process.env.GHES_URL = 'https://github.example.ghe.com';
    const { ghesApiUrl, ghesBaseUrl } = getGitHubEnterpriseApiUrl();
    expect(ghesApiUrl).toBe('https://api.github.example.ghe.com');
    expect(ghesBaseUrl).toBe('https://github.example.ghe.com');
  });

  it('createAppAuthClient returns an Octokit instance', async () => {
    const octokit = await createAppAuthClient();
    expect(octokit).toBeInstanceOf(Octokit);
  });

  it('createAppInstallationClient returns an installation-scoped Octokit', async () => {
    const fakeToken = 'installation-token';
    const fakeInstallationId = 1234;

    // Create a real Octokit instance for the mock to return
    const mockOctokitInstance = new Octokit({ auth: fakeToken });

    // Create app-level Octokit mock with all required methods
    const appOctokit = {
      apps: {
        getOrgInstallation: vi.fn().mockResolvedValue({ data: { id: fakeInstallationId } }),
      },
      // This is the key part - auth() just returns our pre-configured Octokit
      auth: vi.fn().mockResolvedValue(mockOctokitInstance),
      request: { endpoint: { parse: vi.fn().mockReturnValue({ url: '' }) } },
      hook: { before: vi.fn(), after: vi.fn(), error: vi.fn() },
    } as unknown as Octokit;

    const payload = {
      id: 0,
      eventType: 'workflow_job',
      repositoryName: '',
      repositoryOwner: 'test-org',
      installationId: 0,
      repoOwnerType: 'Organization',
    };

    // Act
    const installationClient = await createAppInstallationClient(appOctokit, true, payload);

    // Assert
    expect(appOctokit.apps.getOrgInstallation).toHaveBeenCalledWith({ org: 'test-org' });
    expect(appOctokit.auth).toHaveBeenCalledWith({
      type: 'installation',
      installationId: fakeInstallationId,
      factory: expect.any(Function),
    });
    expect(installationClient).toBe(mockOctokitInstance);
  });
});
