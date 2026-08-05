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

// ---- PluginSettingTab + Setting (used by src/settings.ts) ----
//
// These are sophisticated enough to let `new ReminderTelegramSettingTab(...).display()`
// run end-to-end inside jsdom. Each Setting instance records its name/desc and the
// kind of control it added so tests can assert on the rendered tab.

/** Per-instance metadata for a rendered Setting. Useful in test assertions. */
export interface SettingInstance {
  name: string;
  desc: string;
  isHeading: boolean;
  hasToggle: boolean;
  hasText: boolean;
  hasTextArea: boolean;
  hasDropdown: boolean;
  hasButton: boolean;
}

/** Global registry of MockSetting instances (for live introspection). */
export const _settingInstances: MockSetting[] = [];

/** Reset the registry between tests. */
export function _resetSettingInstances(): void {
  _settingInstances.length = 0;
}

/** Snapshot the current state of a MockSetting into a SettingInstance. */
function snapshot(s: MockSetting): SettingInstance {
  return {
    name: s.name,
    desc: s.desc,
    isHeading: s.isHeading,
    hasToggle: s.hasToggle,
    hasText: s.hasText,
    hasTextArea: s.hasTextArea,
    hasDropdown: s.hasDropdown,
    hasButton: s.hasButton,
  };
}

/**
 * Read the current state of all registered Settings. Returns live snapshots
 * so tests see the post-chaining state.
 */
export function _getSettingSnapshots(): SettingInstance[] {
  return _settingInstances.map(snapshot);
}

type SettingControl = {
  setValue: ReturnType<typeof vi.fn>;
  setPlaceholder: ReturnType<typeof vi.fn>;
  onChange: ReturnType<typeof vi.fn>;
  inputEl: { type: string; addClass: ReturnType<typeof vi.fn> };
};

class MockSetting {
  name = '';
  desc = '';
  isHeading = false;
  hasToggle = false;
  hasText = false;
  hasTextArea = false;
  hasDropdown = false;
  hasButton = false;
  settingEl: HTMLElement;
  private nameEl: HTMLElement;
  private descEl: HTMLElement;

  constructor(_container: HTMLElement) {
    this.settingEl = createObsidianElement('div');
    this.settingEl.classList.add('setting-item');
    this.nameEl = document.createElement('div');
    this.nameEl.className = 'setting-item-name';
    this.descEl = document.createElement('div');
    this.descEl.className = 'setting-item-desc';
    this.settingEl.appendChild(this.nameEl);
    this.settingEl.appendChild(this.descEl);
    // Append into the container so container.textContent reflects what was rendered.
    _container.appendChild(this.settingEl);
    // Register instance reference for test introspection (live snapshot on read).
    _settingInstances.push(this);
  }

  setName(name: string): this {
    this.name = name;
    this.nameEl.textContent = name;
    return this;
  }
  setDesc(desc: string): this {
    this.desc = desc;
    this.descEl.textContent = desc;
    return this;
  }
  setHeading(): this {
    this.isHeading = true;
    this.settingEl.classList.add('setting-item-heading');
    return this;
  }
  addToggle(cb: (toggle: { setValue: ReturnType<typeof vi.fn>; onChange: ReturnType<typeof vi.fn> }) => void): this {
    this.hasToggle = true;
    const toggle = {
      setValue: vi.fn().mockReturnThis(),
      onChange: vi.fn().mockReturnThis(),
    };
    cb(toggle);
    return this;
  }
  addText(cb: (text: SettingControl) => void): this {
    this.hasText = true;
    const text: SettingControl = {
      setValue: vi.fn().mockReturnThis(),
      setPlaceholder: vi.fn().mockReturnThis(),
      onChange: vi.fn().mockReturnThis(),
      inputEl: { type: '', addClass: vi.fn() },
    };
    cb(text);
    return this;
  }
  addTextArea(cb: (text: SettingControl) => void): this {
    this.hasTextArea = true;
    const text: SettingControl = {
      setValue: vi.fn().mockReturnThis(),
      setPlaceholder: vi.fn().mockReturnThis(),
      onChange: vi.fn().mockReturnThis(),
      inputEl: { type: '', addClass: vi.fn() },
    };
    cb(text);
    return this;
  }
  addDropdown(
    cb: (dropdown: { addOption: ReturnType<typeof vi.fn>; setValue: ReturnType<typeof vi.fn>; onChange: ReturnType<typeof vi.fn> }) => void
  ): this {
    this.hasDropdown = true;
    const dropdown = {
      addOption: vi.fn().mockReturnThis(),
      setValue: vi.fn().mockReturnThis(),
      onChange: vi.fn().mockReturnThis(),
    };
    cb(dropdown);
    return this;
  }
  addButton(cb: (button: { setButtonText: ReturnType<typeof vi.fn>; onClick: ReturnType<typeof vi.fn> }) => void): this {
    this.hasButton = true;
    const button = {
      setButtonText: vi.fn().mockReturnThis(),
      onClick: vi.fn().mockReturnThis(),
    };
    cb(button);
    return this;
  }
}

export const Setting = MockSetting as unknown as ReturnType<typeof vi.fn> & (new (container: HTMLElement) => MockSetting);

export class PluginSettingTab {
  containerEl: HTMLElement;
  app: unknown;
  plugin: unknown;
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = createObsidianElement('div');
  }
  display(): void {
    /* overridden by subclasses */
  }
}

/**
 * Build a real HTMLElement and attach Obsidian-style helpers (empty/createEl/createDiv/createSpan)
 * to it AND to every element it produces. Mirrors the real Obsidian runtime, where any
 * node created via these helpers inherits the same DOM-building API.
 */
function createObsidianElement(tag: string, opts?: { cls?: string; text?: string }): HTMLElement {
  const el = document.createElement(tag);
  attachObsidianExtensions(el);
  if (opts?.cls) el.className = opts.cls;
  if (opts?.text) el.textContent = opts.text;
  return el;
}

function attachObsidianExtensions(el: HTMLElement): void {
  if ((el as unknown as { __obsidianExtended?: boolean }).__obsidianExtended) return;
  (el as unknown as { __obsidianExtended: boolean }).__obsidianExtended = true;

  (el as unknown as { empty: () => void }).empty = vi.fn(() => {
    el.innerHTML = '';
  });
  (el as unknown as { addClass: (c: string) => void }).addClass = vi.fn();
  (el as unknown as { removeClass: (c: string) => void }).removeClass = vi.fn();
  (el as unknown as { setAttr: (attr: string, value: string) => void }).setAttr = vi.fn();
  (el as unknown as { setText: (text: string) => void }).setText = vi.fn((text: string) => {
    el.textContent = text;
  });
  (el as unknown as { createEl: (tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => HTMLElement }).createEl =
    vi.fn((tag: string, opts?: { cls?: string; text?: string }) => {
      const created = createObsidianElement(tag, opts);
      el.appendChild(created);
      return created;
    });
  (el as unknown as { createDiv: (opts?: { cls?: string; text?: string }) => HTMLElement }).createDiv = vi.fn(
    (opts?: { cls?: string; text?: string }) => {
      const created = createObsidianElement('div', opts);
      el.appendChild(created);
      return created;
    }
  );
  (el as unknown as { createSpan: (opts?: { cls?: string; text?: string }) => HTMLElement }).createSpan = vi.fn(
    (opts?: { cls?: string; text?: string }) => {
      const created = createObsidianElement('span', opts);
      el.appendChild(created);
      return created;
    }
  );
}

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
  Setting,
  PluginSettingTab,
};

export default obsidianMock;
