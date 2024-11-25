import type * as Vite from "vite";
import { execSync } from "node:child_process";
import path from "node:path";
import fse from "fs-extra";
import colors from "picocolors";
import pick from "lodash/pick";
import omit from "lodash/omit";
import PackageJson from "@npmcli/package-json";
import type * as ViteNode from "./vite-node";

import {
  type RouteManifest,
  type RouteManifestEntry,
  type RouteConfigEntry,
  type RouteConfig,
  setAppDirectory,
  validateRouteConfig,
  configRoutesToRouteManifest,
} from "../config/routes";
import { detectPackageManager } from "../cli/detectPackageManager";
import { importViteEsmSync } from "./import-vite-esm-sync";

const excludedConfigPresetKeys = ["presets"] as const satisfies ReadonlyArray<
  keyof ReactRouterConfig
>;

type ExcludedConfigPresetKey = (typeof excludedConfigPresetKeys)[number];

type ConfigPreset = Omit<ReactRouterConfig, ExcludedConfigPresetKey>;

export type Preset = {
  name: string;
  reactRouterConfig?: (args: {
    reactRouterUserConfig: ReactRouterConfig;
  }) => ConfigPreset | Promise<ConfigPreset>;
  reactRouterConfigResolved?: (args: {
    reactRouterConfig: ResolvedReactRouterConfig;
  }) => void | Promise<void>;
  defineRoutes?: () => RouteConfigEntry[];
};

// Only expose a subset of route properties to the "serverBundles" function
const branchRouteProperties = [
  "id",
  "path",
  "file",
  "index",
] as const satisfies ReadonlyArray<keyof RouteManifestEntry>;
type BranchRoute = Pick<
  RouteManifestEntry,
  (typeof branchRouteProperties)[number]
>;

export const configRouteToBranchRoute = (
  configRoute: RouteManifestEntry
): BranchRoute => pick(configRoute, branchRouteProperties);

export type ServerBundlesFunction = (args: {
  branch: BranchRoute[];
}) => string | Promise<string>;

type BaseBuildManifest = {
  routes: RouteManifest;
};

type DefaultBuildManifest = BaseBuildManifest & {
  serverBundles?: never;
  routeIdToServerBundleId?: never;
};

export type ServerBundlesBuildManifest = BaseBuildManifest & {
  serverBundles: {
    [serverBundleId: string]: {
      id: string;
      file: string;
    };
  };
  routeIdToServerBundleId: Record<string, string>;
};

type ServerModuleFormat = "esm" | "cjs";

interface FutureConfig {}

export type BuildManifest = DefaultBuildManifest | ServerBundlesBuildManifest;

type BuildEndHook = (args: {
  buildManifest: BuildManifest | undefined;
  reactRouterConfig: ResolvedReactRouterConfig;
  viteConfig: Vite.ResolvedConfig;
}) => void | Promise<void>;

export type ReactRouterConfig = {
  /**
   * The path to the `app` directory, relative to `remix.config.js`. Defaults
   * to `"app"`.
   */
  appDirectory?: string;

  /**
   * The output format of the server build. Defaults to "esm".
   */
  serverModuleFormat?: ServerModuleFormat;

  /**
   * Enabled future flags
   */
  future?: [keyof FutureConfig] extends [never]
    ? // Partial<FutureConfig> doesn't work when it's empty so just prevent any keys
      { [key: string]: never }
    : Partial<FutureConfig>;

  /**
   * The React Router app basename.  Defaults to `"/"`.
   */
  basename?: string;
  /**
   * The path to the build directory, relative to the project. Defaults to
   * `"build"`.
   */
  buildDirectory?: string;
  /**
   * A function that is called after the full React Router build is complete.
   */
  buildEnd?: BuildEndHook;
  /**
   * An array of URLs to prerender to HTML files at build time.  Can also be a
   * function returning an array to dynamically generate URLs.
   */
  prerender?:
    | boolean
    | Array<string>
    | ((args: {
        getStaticPaths: () => string[];
      }) => Array<string> | Promise<Array<string>>);
  /**
   * An array of React Router plugin config presets to ease integration with
   * other platforms and tools.
   */
  presets?: Array<Preset>;
  /**
   * The file name of the server build output. This file
   * should end in a `.js` extension and should be deployed to your server.
   * Defaults to `"index.js"`.
   */
  serverBuildFile?: string;
  /**
   * A function for assigning routes to different server bundles. This
   * function should return a server bundle ID which will be used as the
   * bundle's directory name within the server build directory.
   */
  serverBundles?: ServerBundlesFunction;
  /**
   * Enable server-side rendering for your application. Disable to use "SPA
   * Mode", which will request the `/` path at build-time and save it as an
   * `index.html` file with your assets so your application can be deployed as a
   * SPA without server-rendering. Default's to `true`.
   */
  ssr?: boolean;
};

export type ResolvedReactRouterConfig = Readonly<{
  /**
   * The absolute path to the application source directory.
   */
  appDirectory: string;
  /**
   * The React Router app basename.  Defaults to `"/"`.
   */
  basename: string;
  /**
   * The absolute path to the build directory.
   */
  buildDirectory: string;
  /**
   * A function that is called after the full React Router build is complete.
   */
  buildEnd?: BuildEndHook;
  /**
   * Enabled future flags
   */
  future: FutureConfig;
  /**
   * An array of URLs to prerender to HTML files at build time.  Can also be a
   * function returning an array to dynamically generate URLs.
   */
  prerender: ReactRouterConfig["prerender"];
  /**
   * An object of all available routes, keyed by route id.
   */
  routes: RouteManifest;
  /**
   * The file name of the server build output. This file
   * should end in a `.js` extension and should be deployed to your server.
   * Defaults to `"index.js"`.
   */
  serverBuildFile: string;
  /**
   * A function for assigning routes to different server bundles. This
   * function should return a server bundle ID which will be used as the
   * bundle's directory name within the server build directory.
   */
  serverBundles?: ServerBundlesFunction;
  /**
   * The output format of the server build. Defaults to "esm".
   */
  serverModuleFormat: ServerModuleFormat;
  /**
   * Enable server-side rendering for your application. Disable to use "SPA
   * Mode", which will request the `/` path at build-time and save it as an
   * `index.html` file with your assets so your application can be deployed as a
   * SPA without server-rendering. Default's to `true`.
   */
  ssr: boolean;
}>;

let mergeReactRouterConfig = (
  ...configs: ReactRouterConfig[]
): ReactRouterConfig => {
  let reducer = (
    configA: ReactRouterConfig,
    configB: ReactRouterConfig
  ): ReactRouterConfig => {
    let mergeRequired = (key: keyof ReactRouterConfig) =>
      configA[key] !== undefined && configB[key] !== undefined;

    return {
      ...configA,
      ...configB,
      ...(mergeRequired("buildEnd")
        ? {
            buildEnd: async (...args) => {
              await Promise.all([
                configA.buildEnd?.(...args),
                configB.buildEnd?.(...args),
              ]);
            },
          }
        : {}),
      ...(mergeRequired("future")
        ? {
            future: {
              ...configA.future,
              ...configB.future,
            },
          }
        : {}),
      ...(mergeRequired("presets")
        ? {
            presets: [...(configA.presets ?? []), ...(configB.presets ?? [])],
          }
        : {}),
    };
  };

  return configs.reduce(reducer, {});
};

// Inlined from https://github.com/jsdf/deep-freeze
let deepFreeze = (o: any) => {
  Object.freeze(o);
  let oIsFunction = typeof o === "function";
  let hasOwnProp = Object.prototype.hasOwnProperty;
  Object.getOwnPropertyNames(o).forEach(function (prop) {
    if (
      hasOwnProp.call(o, prop) &&
      (oIsFunction
        ? prop !== "caller" && prop !== "callee" && prop !== "arguments"
        : true) &&
      o[prop] !== null &&
      (typeof o[prop] === "object" || typeof o[prop] === "function") &&
      !Object.isFrozen(o[prop])
    ) {
      deepFreeze(o[prop]);
    }
  });
  return o;
};

export function resolvePublicPath(viteUserConfig: Vite.UserConfig) {
  return viteUserConfig.base ?? "/";
}

let isFirstLoad = true;
let lastValidRoutes: RouteManifest = {};

export async function resolveReactRouterConfig({
  rootDirectory,
  reactRouterUserConfig,
  routeConfigChanged,
  viteUserConfig,
  viteCommand,
  routesViteNodeContext,
}: {
  rootDirectory: string;
  reactRouterUserConfig: ReactRouterConfig;
  routeConfigChanged: boolean;
  viteUserConfig: Vite.UserConfig;
  viteCommand: Vite.ConfigEnv["command"];
  routesViteNodeContext: ViteNode.Context;
}) {
  let vite = importViteEsmSync();

  let logger = vite.createLogger(viteUserConfig.logLevel, {
    prefix: "[react-router]",
  });

  let presets: ReactRouterConfig[] = (
    await Promise.all(
      (reactRouterUserConfig.presets ?? []).map(async (preset) => {
        if (!preset.name) {
          throw new Error(
            "React Router presets must have a `name` property defined."
          );
        }

        if (!preset.reactRouterConfig) {
          return null;
        }

        let configPreset: ReactRouterConfig = omit(
          await preset.reactRouterConfig({ reactRouterUserConfig }),
          excludedConfigPresetKeys
        );

        return configPreset;
      })
    )
  ).filter(function isNotNull<T>(value: T | null): value is T {
    return value !== null;
  });

  let defaults = {
    basename: "/",
    buildDirectory: "build",
    serverBuildFile: "index.js",
    serverModuleFormat: "esm",
    ssr: true,
  } as const satisfies Partial<ReactRouterConfig>;

  let {
    appDirectory: userAppDirectory,
    basename,
    buildDirectory: userBuildDirectory,
    buildEnd,
    prerender,
    serverBuildFile,
    serverBundles,
    serverModuleFormat,
    ssr,
  } = {
    ...defaults, // Default values should be completely overridden by user/preset config, not merged
    ...mergeReactRouterConfig(...presets, reactRouterUserConfig),
  };

  // Log warning for incompatible vite config flags
  if (!ssr && serverBundles) {
    console.warn(
      colors.yellow(
        colors.bold("⚠️  SPA Mode: ") +
          "the `serverBundles` config is invalid with " +
          "`ssr:false` and will be ignored`"
      )
    );
    serverBundles = undefined;
  }

  let isValidPrerenderConfig =
    prerender == null ||
    typeof prerender === "boolean" ||
    Array.isArray(prerender) ||
    typeof prerender === "function";

  if (!isValidPrerenderConfig) {
    logger.error(
      colors.red(
        "The `prerender` config must be a boolean, an array of string paths, " +
          "or a function returning a boolean or array of string paths"
      )
    );
    process.exit(1);
  }

  let appDirectory = path.resolve(rootDirectory, userAppDirectory || "app");
  let buildDirectory = path.resolve(rootDirectory, userBuildDirectory);
  let publicPath = resolvePublicPath(viteUserConfig);

  if (
    basename !== "/" &&
    viteCommand === "serve" &&
    !viteUserConfig.server?.middlewareMode &&
    !basename.startsWith(publicPath)
  ) {
    logger.error(
      colors.red(
        "When using the React Router `basename` and the Vite `base` config, " +
          "the `basename` config must begin with `base` for the default " +
          "Vite dev server."
      )
    );
    process.exit(1);
  }

  let rootRouteFile = findEntry(appDirectory, "root");
  if (!rootRouteFile) {
    let rootRouteDisplayPath = path.relative(
      rootDirectory,
      path.join(appDirectory, "root.tsx")
    );
    logger.error(
      colors.red(
        `Could not find a root route module in the app directory as "${rootRouteDisplayPath}"`
      )
    );
    process.exit(1);
  }

  let routes: RouteManifest = {
    root: { path: "", id: "root", file: rootRouteFile },
  };

  let routeConfigFile = findEntry(appDirectory, "routes");

  class FriendlyError extends Error {}

  try {
    if (!routeConfigFile) {
      let routeConfigDisplayPath = vite.normalizePath(
        path.relative(rootDirectory, path.join(appDirectory, "routes.ts"))
      );
      throw new FriendlyError(
        `Route config file not found at "${routeConfigDisplayPath}".`
      );
    }

    setAppDirectory(appDirectory);
    let routeConfigExport: RouteConfig = (
      await routesViteNodeContext.runner.executeFile(
        path.join(appDirectory, routeConfigFile)
      )
    ).routes;

    let routeConfig = await routeConfigExport;

    let result = validateRouteConfig({
      routeConfigFile,
      routeConfig,
    });

    if (!result.valid) {
      throw new FriendlyError(result.message);
    }

    routes = { ...routes, ...configRoutesToRouteManifest(routeConfig) };

    lastValidRoutes = routes;

    if (routeConfigChanged) {
      logger.info(colors.green("Route config changed."), {
        clear: true,
        timestamp: true,
      });
    }
  } catch (error: any) {
    logger.error(
      error instanceof FriendlyError
        ? colors.red(error.message)
        : [
            colors.red(`Route config in "${routeConfigFile}" is invalid.`),
            "",
            error.loc?.file && error.loc?.column && error.frame
              ? [
                  path.relative(appDirectory, error.loc.file) +
                    ":" +
                    error.loc.line +
                    ":" +
                    error.loc.column,
                  error.frame.trim?.(),
                ]
              : error.stack,
          ]
            .flat()
            .join("\n") + "\n",
      {
        error,
        clear: !isFirstLoad,
        timestamp: !isFirstLoad,
      }
    );

    // Bail if this is the first time loading config, otherwise keep the dev server running
    if (isFirstLoad) {
      process.exit(1);
    }

    // Keep dev server running with the last valid routes to allow for correction
    routes = lastValidRoutes;
  }

  let future: FutureConfig = {};

  let reactRouterConfigRoutes = routes
  
  let reactRouterConfig: ResolvedReactRouterConfig = deepFreeze({
    appDirectory,
    basename,
    buildDirectory,
    buildEnd,
    future,
    prerender,
    routes: reactRouterConfigRoutes,
    serverBuildFile,
    serverBundles,
    serverModuleFormat,
    ssr,
  });

  for (let preset of reactRouterUserConfig.presets ?? []) {
    await preset.reactRouterConfigResolved?.({ reactRouterConfig });

    const userDefinedRoutes = preset.defineRoutes?.();

    if (userDefinedRoutes) {
      const userRoureManifest = configRoutesToRouteManifest(userDefinedRoutes)

      reactRouterConfigRoutes = {
        ...reactRouterConfigRoutes,
        ...userRoureManifest
      }
    }
  }

  isFirstLoad = false;

  return reactRouterConfig;
}

export async function resolveEntryFiles({
  rootDirectory,
  reactRouterConfig,
}: {
  rootDirectory: string;
  reactRouterConfig: ResolvedReactRouterConfig;
}) {
  let { appDirectory } = reactRouterConfig;

  let defaultsDirectory = path.resolve(
    path.dirname(require.resolve("@react-router/dev/package.json")),
    "dist",
    "config",
    "defaults"
  );

  let userEntryClientFile = findEntry(appDirectory, "entry.client");
  let userEntryServerFile = findEntry(appDirectory, "entry.server");

  let entryServerFile: string;
  let entryClientFile = userEntryClientFile || "entry.client.tsx";

  let pkgJson = await PackageJson.load(rootDirectory);
  let deps = pkgJson.content.dependencies ?? {};

  if (userEntryServerFile) {
    entryServerFile = userEntryServerFile;
  } else {
    if (!deps["@react-router/node"]) {
      throw new Error(
        `Could not determine server runtime. Please install @react-router/node, or provide a custom entry.server.tsx/jsx file in your app directory.`
      );
    }

    if (!deps["isbot"]) {
      console.log(
        "adding `isbot@5` to your package.json, you should commit this change"
      );

      pkgJson.update({
        dependencies: {
          ...pkgJson.content.dependencies,
          isbot: "^5",
        },
      });

      await pkgJson.save();

      let packageManager = detectPackageManager() ?? "npm";

      execSync(`${packageManager} install`, {
        cwd: rootDirectory,
        stdio: "inherit",
      });
    }

    entryServerFile = `entry.server.node.tsx`;
  }

  let entryClientFilePath = userEntryClientFile
    ? path.resolve(reactRouterConfig.appDirectory, userEntryClientFile)
    : path.resolve(defaultsDirectory, entryClientFile);

  let entryServerFilePath = userEntryServerFile
    ? path.resolve(reactRouterConfig.appDirectory, userEntryServerFile)
    : path.resolve(defaultsDirectory, entryServerFile);

  return { entryClientFilePath, entryServerFilePath };
}

const entryExts = [".js", ".jsx", ".ts", ".tsx"];

export function findEntry(dir: string, basename: string): string | undefined {
  for (let ext of entryExts) {
    let file = path.resolve(dir, basename + ext);
    if (fse.existsSync(file)) return path.relative(dir, file);
  }

  return undefined;
}
