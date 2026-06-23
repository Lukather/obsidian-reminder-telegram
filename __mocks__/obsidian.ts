/**
 * Auto-mock for the Obsidian module.
 *
 * Provides vi.fn() stubs for all exports used across the codebase.
 * Tests can further override individual mocks via `import { requestUrl } from 'obsidian';
 * beforeEach(() => requestUrl.mockResolvedValue(...))`.
 */

import { vi } from 'vitest';

// ---- Utility class stubs ----

class MockComponent {
  containerEl = {
    createEl: vi.fn().mockReturnThis(),
    createDiv: vi.fn().mockReturnThis(),
    empty: vi.fn(),
    addClass: vi.fn(),
    removeClass: vi.fn(),
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    appendChild: vi.fn(),
    innerText: '',
    innerHTML: '',
    style: {} as CSSStyleDeclaration,
  } as unknown as HTMLElement;

  registerInterval = vi.fn();
  registerEvent = vi.fn();
  addCommand = vi.fn();
  addSettingTab = vi.fn();
  loadData = vi.fn().mockResolvedValue(undefined);
  saveData = vi.fn().mockResolvedValue(undefined);
}

// ---- Exported mocks ----

export const Notice = vi.fn();
export const Plugin = vi.fn().mockImplementation(() => new MockComponent());

export const requestUrl = vi.fn().mockResolvedValue({
  text: JSON.stringify({ ok: true }),
  json: { ok: true },
  status: 200,
});

export class MockTFile {
  path: string;
  name: string;
  extension: string;
  vault: MockVault;

  constructor(path: string) {
    this.path = path;
    this.name = path.split('/').pop() || path;
    this.extension = this.name.split('.').pop() || '';
    this.vault = new MockVault();
  }

  static fromPath(path: string): MockTFile {
    return new MockTFile(path);
  }
}
export { MockTFile as TFile };

export class MockVault {
  getFiles = vi.fn().mockReturnValue([]);
  read = vi.fn().mockResolvedValue('');
  cachedRead = vi.fn().mockResolvedValue('');
  create = vi.fn();
  modify = vi.fn();
  delete = vi.fn();
  rename = vi.fn();
  getAbstractFileByPath = vi.fn();
  adapter = {
    read: vi.fn().mockResolvedValue(''),
    write: vi.fn(),
    exists: vi.fn().mockResolvedValue(true),
    list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
  };
}
export { MockVault as Vault };

export class MockMetadataCache {
  getFileCache = vi.fn().mockReturnValue(null);
  on = vi.fn();
  off = vi.fn();
}
export { MockMetadataCache as MetadataCache };

export class MockApp {
  vault = new MockVault();
  metadataCache = new MockMetadataCache();
  workspace = {
    getActiveViewOfType: vi.fn(),
    getActiveFile: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getLeavesOfType: vi.fn().mockReturnValue([]),
  };
  setting = {
    openTabById: vi.fn(),
    open: vi.fn(),
  };
  isMobile = false;
}
export { MockApp as App };

export const TAbstractFile = vi.fn();
export const MarkdownView = vi.fn();
export const ItemView = vi.fn();
export const WorkspaceLeaf = vi.fn();

// ---- Default export for wildcard imports ----

const obsidianMock = {
  Notice,
  Plugin,
  requestUrl,
  TFile: MockTFile,
  Vault: MockVault,
  MetadataCache: MockMetadataCache,
  App: MockApp,
  TAbstractFile,
  MarkdownView,
  ItemView,
  WorkspaceLeaf,
};

export default obsidianMock;
