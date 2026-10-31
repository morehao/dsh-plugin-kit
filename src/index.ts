/**
 * `@morehao/dsh-plugin-kit` 的 host 通用入口。
 *
 * 这里只放与「插件自身维护」相关的纯逻辑：semver、registry 约定、profile 安装形态判定。
 * 自更新引擎在 `@morehao/dsh-plugin-kit/update`，客户端控制器在 `/update/client`，
 * HTTP 小工具在 `/http`——分开是为了让没有 web 层的插件不必把用不到的东西带上。
 */
export { compareVersions, isNewerVersion, parseSemver, type Semver } from './semver.js';
export {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  OFFICIAL_REGISTRY,
  encodePackageName,
  manualCommand,
  normalizeRegistry,
  registryPlan,
  type RegistriesLike,
} from './registry.js';
export {
  classifyInstallSpec,
  detectInstallKind,
  normalizeProfile,
  readDeclaredSpec,
  type DetectDeps,
  type InstallKind,
  type InstallKindResult,
  type ProfileLike,
} from './profile.js';
