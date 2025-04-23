import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Octokit } from '@octokit/rest';
import { EndpointDefaults, OctokitResponse, RequestOptions } from '@octokit/types';
import { RequestError } from '@octokit/request-error';
import { Lru } from 'toad-cache';
import * as nock from 'nock';
import { getParameter } from '@aws-github-runner/aws-ssm-util';
import {
  createAppAuthClient,
  createAppInstallationClient,
  getGitHubEnterpriseApiUrl,
  beforeRequestHandler,
  afterRequestHandler,
  errorRequestHandler,
  type CacheEntry,
} from './client';

vi.mock('@aws-github-runner/aws-ssm-util', () => ({
  getParameter: vi.fn(),
}));

const mockedGet = vi.mocked(getParameter);

mockedGet.mockImplementation((name: string) => {
  if (name === process.env.PARAMETER_GITHUB_APP_ID_NAME) {
    return Promise.resolve('1234');
  }
  if (name === process.env.PARAMETER_GITHUB_APP_KEY_BASE64_NAME) {
    return Promise.resolve(Buffer.from('test-private-key').toString('base64'));
  }
  return Promise.resolve('');
});

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

vi.mock('@aws-github-runner/aws-ssm-util', () => ({
  getParameter: vi.fn((name: string) => {
    if (name === process.env.PARAMETER_GITHUB_APP_ID_NAME) return Promise.resolve('1337');
    if (name === process.env.PARAMETER_GITHUB_APP_KEY_BASE64_NAME) {
      return Promise.resolve(process.env.GITHUB_APP_KEY_BASE64);
    }
    return Promise.resolve('');
  }),
}));

vi.mock('toad-cache', () => {
  const mockCache = {
    get: vi.fn(),
  };
  return { Lru: vi.fn(() => mockCache) };
});

describe('getGitHubEnterpriseUrl', () => {
  it('returns correct URLs', () => {
    process.env.GHES_URL = 'https://github.example.ghe.com';
    const { ghesApiUrl, ghesBaseUrl } = getGitHubEnterpriseApiUrl();
    expect(ghesApiUrl).toBe('https://api.github.example.ghe.com');
    expect(ghesBaseUrl).toBe('https://github.example.ghe.com');
  });

  it('createAppAuthClient returns an Octokit instance', async () => {
    const octokit = await createAppAuthClient();
    expect(octokit).toBeInstanceOf(Octokit);
  });
});

describe('createAppInstallationClient', () => {
  it('returns an installation-scoped Octokit for an organization', async () => {
    // Arrange
    const installationOctokit = new Octokit();

    const mockAppClient = {
      apps: {
        getOrgInstallation: vi.fn().mockResolvedValue({ data: { id: 12345 } }),
        getRepoInstallation: vi.fn(),
      },
      auth: vi.fn().mockResolvedValue(installationOctokit)
    };

    const enableOrgLevel = true;
    const runnerOwner = 'my-org';

    // Act
    const installationClient = await createAppInstallationClient(
      mockAppClient as unknown as Octokit,
      enableOrgLevel,
      runnerOwner
    );

    // Assert
    expect(mockAppClient.apps.getOrgInstallation).toHaveBeenCalledWith({ org: 'my-org' });
    expect(mockAppClient.auth).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'installation',
        installationId: 12345,
      })
    );
    expect(installationClient).toBe(installationOctokit);
  });

  it('returns an installation-scoped Octokit for a repository', async () => {
    // Arrange
    const installationOctokit = new Octokit();

    const mockAppClient = {
      apps: {
        getOrgInstallation: vi.fn(),
        getRepoInstallation: vi.fn().mockResolvedValue({ data: { id: 67890 } }),
      },
      auth: vi.fn().mockResolvedValue(installationOctokit)
    };

    const enableOrgLevel = false;
    const runnerOwner = 'my-org/my-repo';

    // Act
    const installationClient = await createAppInstallationClient(
      mockAppClient as unknown as Octokit,
      enableOrgLevel,
      runnerOwner
    );

    // Assert
    expect(mockAppClient.apps.getRepoInstallation).toHaveBeenCalledWith({
      owner: 'my-org',
      repo: 'my-repo',
    });
    expect(mockAppClient.auth).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'installation',
        installationId: 67890,
      })
    );
    expect(installationClient).toBe(installationOctokit);
  });
});

describe('beforeRequestHandler', () => {
  let mockOctokit: { request: { endpoint: { parse: (options: EndpointDefaults) => { url: string } } } };
  let options: { method: string; headers: Record<string, string> };
  let mockCache: Lru<CacheEntry>;

  beforeEach(() => {
    mockCache = new Lru<CacheEntry>();
    mockCache.get = vi.fn();
    mockOctokit = {
      request: {
        endpoint: {
          parse: vi.fn().mockReturnValue({ url: 'https://api.github.com/test' }),
        },
      },
    };
    options = {
      method: 'GET',
      headers: {},
    };
  });

  it('sets conditional headers on cache hit', async () => {
    const cacheEntry = {
      etag: '"12345"',
      lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
    };

    (mockCache.get as import('vitest').Mock).mockReturnValue(cacheEntry);

    await beforeRequestHandler(mockCache, mockOctokit as Octokit, options as EndpointDefaults);

    expect(options.headers['If-None-Match']).toBe(cacheEntry.etag);
    expect(options.headers['If-Modified-Since']).toBe(cacheEntry.lastModified);
  });

  it('does not set headers on cache miss', async () => {
    (mockCache.get as import('vitest').Mock).mockReturnValue(undefined);

    await beforeRequestHandler(mockCache, mockOctokit as Octokit, options as EndpointDefaults);

    expect(options.headers['If-None-Match']).toBeUndefined();
    expect(options.headers['If-Modified-Since']).toBeUndefined();
  });
});

describe('afterRequestHandler', () => {
  let mockOctokit: { request: { endpoint: { parse: (options: EndpointDefaults) => { url: string } } } };
  let mockCache: Lru<CacheEntry>;

  beforeEach(() => {
    mockCache = new Lru<CacheEntry>();
    mockCache.set = vi.fn();
    mockOctokit = {
      request: {
        endpoint: {
          parse: vi.fn().mockReturnValue({ url: 'https://api.github.com/test' }),
        },
      },
    };
  });

  it('caches response with ETag and Last-Modified headers', async () => {
    // Arrange
    const response = {
      status: 200,
      headers: {
        etag: '"12345"',
        'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
      },
    };
    const options = { method: 'GET', url: 'https://api.github.com/test' };

    // Act
    await afterRequestHandler(mockOctokit as Octokit, response as OctokitResponse<number>, options as EndpointDefaults);

    // Assert
    expect(mockCache.set).toHaveBeenCalledWith('https://api.github.com/test', {
      etag: '"12345"',
      lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
      ...response,
    });
  });

  it('does not cache response without ETag or Last-Modified headers', async () => {
    // Arrange
    const response = {
      status: 200,
      headers: {},
    };
    const options = { method: 'GET', url: 'https://api.github.com/test' };

    // Act
    await afterRequestHandler(mockOctokit as Octokit, response as OctokitResponse<number>, options as EndpointDefaults);

    // Assert
    expect(mockCache.set).not.toHaveBeenCalled();
  });
});

describe('errorRequestHandler', () => {
  let mockOctokit: { request: { endpoint: { parse: (options: EndpointDefaults) => { url: string } } } };
  let mockCache: Lru<CacheEntry>;

  beforeEach(() => {
    mockCache = new Lru<CacheEntry>();
    mockCache.get = vi.fn();
    mockOctokit = {
      request: {
        endpoint: {
          parse: vi.fn().mockReturnValue({ url: 'https://api.github.com/test' }),
        },
      },
    };
  });

  const requestOptions: RequestOptions = {
    method: 'GET',
    url: 'https://api.github.com/test',
    headers: {},
  };

  it('returns cached entry on 304 Not Modified error', async () => {
    // Arrange
    const cacheEntry = {
      etag: '"12345"',
      lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
    };
    (mockCache.get as import('vitest').Mock).mockReturnValue(cacheEntry);

    const error = new RequestError('Not Modified', 304, { request: requestOptions } );
    error.status = 304;

    // Act
    const result = await errorRequestHandler(mockOctokit as Octokit, error, requestOptions as EndpointDefaults);

    // Assert
    expect(result).toEqual(cacheEntry);
  });

  it('throws error if cache entry is missing on 304 Not Modified error', async () => {
    // Arrange
    (mockCache.get as import('vitest').Mock).mockReturnValue(undefined);

    const error = new RequestError('Not Modified', 304, { request: requestOptions } );
    error.status = 304;

    const options = { method: 'GET', url: 'https://api.github.com/test' };

    // Act & Assert
    await expect(errorRequestHandler(mockOctokit as Octokit, error, options as EndpointDefaults))
      .rejects.toThrow(
        'Received 304 Not Modified response for https://api.github.com/test, but it wasn\'t found in the cache.'
    );
  });

  it('throws error for non-304 errors', async () => {
    // Arrange
    const error = new Error('Bad Request');

    const options = { method: 'GET', url: 'https://api.github.com/test' };

    // Act & Assert
    await expect(errorRequestHandler(mockOctokit as Octokit, error, options as EndpointDefaults))
      .rejects.toThrow('Bad Request');
  });
});

describe('createAppAuthClient', () => {
  test('Creates app client to GitHub public', async () => {
    // Arrange
    const appId = '1234';
    const privateKey = 'test-private-key';
    mockedGet.mockResolvedValueOnce(appId).mockResolvedValueOnce(Buffer.from(privateKey).toString('base64'));

    // Act
    const client = await createAppAuthClient();

    // Assert
    expect(client).toBeInstanceOf(Octokit);
    expect(client.request.endpoint.DEFAULTS.baseUrl).toBe('https://api.github.com');
  });

  test('Creates app client to GitHub Enterprise Server', async () => {
    // Arrange
    const appId = '1234';
    const privateKey = 'test-private-key';
    const ghesUrl = 'https://github.enterprise.example.com';
    process.env.GHES_URL = ghesUrl; // Set the GHES_URL environment variable
    mockedGet.mockResolvedValueOnce(appId).mockResolvedValueOnce(Buffer.from(privateKey).toString('base64'));

    // Act
    const client = await createAppAuthClient(ghesUrl);

    // Assert
    expect(client).toBeInstanceOf(Octokit);
    expect(client.request.endpoint.DEFAULTS.baseUrl).toBe(ghesUrl);
    expect(client.request.endpoint.DEFAULTS.mediaType.previews).toContain('antiope');
  });
});

describe('Test getGitHubEnterpriseApiUrl', () => {
  test('Returns correct URLs for GitHub Enterprise Server', () => {
    // Arrange
    process.env.GHES_URL = 'https://github.enterprise.example.com';

    // Act
    const { ghesApiUrl, ghesBaseUrl } = getGitHubEnterpriseApiUrl();

    // Assert
    expect(ghesApiUrl).toBe('https://github.enterprise.example.com/api/v3');
    expect(ghesBaseUrl).toBe('https://github.enterprise.example.com');
  });

  test('Returns empty URLs when GHES_URL is not set', () => {
    // Arrange
    process.env.GHES_URL = '';

    // Act
    const { ghesApiUrl, ghesBaseUrl } = getGitHubEnterpriseApiUrl();

    // Assert
    expect(ghesApiUrl).toBe('');
    expect(ghesBaseUrl).toBe('');
  });
});
