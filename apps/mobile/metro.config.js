// Monorepo setup: the app imports the shared protocol code straight from packages/core/src.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);

config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [path.join(projectRoot, "node_modules"), path.join(repoRoot, "node_modules")];

// The core uses Node's "crypto" and "buffer" APIs; these packages provide them natively.
const aliases = {
  crypto: "react-native-quick-crypto",
  buffer: "@craftzdog/react-native-buffer",
};
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const target = aliases[moduleName] ?? moduleName;
  return (upstream ?? context.resolveRequest)(context, target, platform);
};
config.resolver.unstable_conditionNames = ["react-native", "require", "default"];

module.exports = config;
