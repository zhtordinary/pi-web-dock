"use strict";

function isHostRuntimeVariable(name, platform = process.platform) {
  const comparableName = platform === "win32" ? name.toUpperCase() : name;
  return comparableName === "PORT" || comparableName === "NODE_ENV" || comparableName.startsWith("NEXT_") || comparableName === "PI_WEB_PASSWORD";
}
function sanitizeProjectCommandEnvironment(baseEnvironment, platform = process.platform) {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) if (isHostRuntimeVariable(name, platform)) delete environment[name];
  return environment;
}
module.exports = { isHostRuntimeVariable, sanitizeProjectCommandEnvironment };
