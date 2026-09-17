import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DEFINITIONS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'definitions');
const MAX_SKILL_BYTES = 128 * 1024;
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_FIELDS = Object.freeze(['schema', 'id', 'name', 'version', 'summary', 'agents', 'mode', 'risk', 'tools']);

const skillError = (code, message) => Object.assign(new Error(message), { code });

const parseScalar = (raw) => {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  if (/^\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
};

export const parseSkillDocument = (text) => {
  if (typeof text !== 'string' || !text.startsWith('---\n')) throw skillError('INVALID_SKILL_DOCUMENT', 'SKILL.md must start with YAML frontmatter');
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) throw skillError('INVALID_SKILL_DOCUMENT', 'SKILL.md frontmatter is not closed');

  const metadata = {};
  for (const rawLine of text.slice(4, end).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) throw skillError('INVALID_SKILL_FRONTMATTER', `Invalid frontmatter line: ${rawLine}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!key || Object.prototype.hasOwnProperty.call(metadata, key)) throw skillError('INVALID_SKILL_FRONTMATTER', `Duplicate or empty frontmatter key: ${key || '<empty>'}`);
    metadata[key] = parseScalar(value);
  }

  for (const field of REQUIRED_FIELDS) {
    if (metadata[field] === undefined || metadata[field] === null || metadata[field] === '') throw skillError('INVALID_SKILL_METADATA', `Missing required skill field: ${field}`);
  }
  if (metadata.schema !== 'hearth-skill-v1') throw skillError('UNSUPPORTED_SKILL_SCHEMA', `Unsupported skill schema: ${metadata.schema}`);
  if (typeof metadata.id !== 'string' || !SKILL_ID.test(metadata.id)) throw skillError('INVALID_SKILL_ID', 'Skill id must be lowercase kebab-case');
  if (typeof metadata.name !== 'string' || !metadata.name.trim()) throw skillError('INVALID_SKILL_METADATA', 'Skill name must be a non-empty string');
  if (!Number.isInteger(metadata.version) || metadata.version < 1) throw skillError('INVALID_SKILL_METADATA', 'Skill version must be a positive integer');
  if (typeof metadata.summary !== 'string' || !metadata.summary.trim()) throw skillError('INVALID_SKILL_METADATA', 'Skill summary must be a non-empty string');
  if (!Array.isArray(metadata.agents) || metadata.agents.length === 0 || metadata.agents.some((agent) => typeof agent !== 'string' || !SKILL_ID.test(agent))) throw skillError('INVALID_SKILL_METADATA', 'Skill agents must be a non-empty array of identifiers');
  if (typeof metadata.mode !== 'string' || !metadata.mode.trim()) throw skillError('INVALID_SKILL_METADATA', 'Skill mode must be a non-empty string');
  if (typeof metadata.risk !== 'string' || !metadata.risk.trim()) throw skillError('INVALID_SKILL_METADATA', 'Skill risk must be a non-empty string');
  if (!Array.isArray(metadata.tools) || metadata.tools.some((tool) => typeof tool !== 'string' || !tool.trim())) throw skillError('INVALID_SKILL_METADATA', 'Skill tools must be an array of tool names');

  metadata.agents = Object.freeze([...new Set(metadata.agents)]);
  metadata.tools = Object.freeze([...new Set(metadata.tools)]);
  return Object.freeze({ metadata: Object.freeze(metadata), instructions: text.slice(end + 5).trim() });
};

export class HearthSkillRegistry {
  constructor({ definitionsRoot = DEFAULT_DEFINITIONS_ROOT, fsApi = fs } = {}) {
    this.definitionsRoot = path.resolve(definitionsRoot);
    this.fs = fsApi;
  }

  async root() {
    let real;
    try { real = await this.fs.realpath(this.definitionsRoot); }
    catch { throw skillError('SKILL_ROOT_UNAVAILABLE', 'Hearth skill definitions root is unavailable'); }
    const stat = await this.fs.stat(real);
    if (!stat.isDirectory()) throw skillError('SKILL_ROOT_UNAVAILABLE', 'Hearth skill definitions root is not a directory');
    return real;
  }

  async resolveSkillFile(id) {
    if (typeof id !== 'string' || !SKILL_ID.test(id)) throw skillError('INVALID_SKILL_ID', 'Skill id must be lowercase kebab-case');
    const root = await this.root();
    const candidate = path.join(root, id, 'SKILL.md');
    let real;
    try { real = await this.fs.realpath(candidate); }
    catch { throw skillError('SKILL_NOT_FOUND', `Skill not found: ${id}`); }
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw skillError('SKILL_PATH_REJECTED', 'Skill path escaped the definitions root');
    const stat = await this.fs.stat(real);
    if (!stat.isFile()) throw skillError('SKILL_NOT_FOUND', `Skill not found: ${id}`);
    if (stat.size > MAX_SKILL_BYTES) throw skillError('SKILL_TOO_LARGE', `Skill definition exceeds ${MAX_SKILL_BYTES} bytes`);
    return { root, real };
  }

  async readDefinition(id) {
    const { real } = await this.resolveSkillFile(id);
    const parsed = parseSkillDocument(await this.fs.readFile(real, 'utf8'));
    if (parsed.metadata.id !== id) throw skillError('SKILL_ID_MISMATCH', `Skill directory '${id}' does not match metadata id '${parsed.metadata.id}'`);
    return parsed;
  }

  async listMetadata({ agent } = {}) {
    const root = await this.root();
    const entries = await this.fs.readdir(root, { withFileTypes: true });
    const skills = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !SKILL_ID.test(entry.name)) continue;
      try {
        const definition = await this.readDefinition(entry.name);
        if (!agent || definition.metadata.agents.includes(agent)) skills.push(definition.metadata);
      } catch (error) {
        if (error?.code === 'SKILL_NOT_FOUND') continue;
        throw error;
      }
    }
    return Object.freeze(skills);
  }

  async load(id, { agent, availableTools } = {}) {
    const definition = await this.readDefinition(id);
    if (agent && !definition.metadata.agents.includes(agent)) throw skillError('SKILL_AGENT_REJECTED', `Skill '${id}' is not available to agent '${agent}'`);

    const available = availableTools === undefined ? null : new Set(availableTools);
    const requestedTools = [...definition.metadata.tools];
    const permittedTools = available ? requestedTools.filter((tool) => available.has(tool)) : [];
    const missingTools = available ? requestedTools.filter((tool) => !available.has(tool)) : [...requestedTools];

    return Object.freeze({
      metadata: definition.metadata,
      instructions: definition.instructions,
      requestedTools: Object.freeze(requestedTools),
      permittedTools: Object.freeze(permittedTools),
      missingTools: Object.freeze(missingTools),
      grantsPermissions: false,
    });
  }
}

export const createHearthSkillRegistry = (options = {}) => new HearthSkillRegistry(options);
