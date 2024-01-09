import * as core from "@actions/core";
import { getExecOutput as exec } from "@actions/exec";
import { ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";

let ecsClient = new ECSClient();

main();

async function main() {
  try {
    const app = core.getInput("app", { required: "true" });
    const project = core.getInput("project", { required: "true" });

    const { service, cluster } = await getWaypointResources(app, project);
    await restartService(cluster, service);
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  }
}

async function getWaypointResources(app, project) {
  const { stdout } = await exec("waypoint", ["status", "-local", "-json", `-project=${project}`, `-app=${app}`]);
  const output = stdout.replace(/^[^{]*{/, "{");

  let result = {};
  const resources = JSON.parse(output).DeploymentResourcesSummary;
  for (const resource of resources) {
    result[resource.Type] = resource.Name;
  }

  return result;
}

async function restartService(cluster, service) {
  console.log(`Updating service: ${service}`);

  const command = new UpdateServiceCommand({
    cluster,
    service,
    forceNewDeployment: true,
  });
  await ecsClient.send(command);

  console.log(`Service updated: ${service}`);
}
