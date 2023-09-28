import { getExecOutput as exec } from "@actions/exec";
import { DescribeServicesCommand, ECSClient, TagResourceCommand } from "@aws-sdk/client-ecs";

let ecsClient = new ECSClient();

main();

async function main() {
  try {
    const app = core.getInput("app", { required: "true" });
    const project = core.getInput("project", { required: "true" });
    const environment = core.getInput("environment", { required: "true" });

    const { service, cluster } = await getWaypointResources(app, project);
    const serviceArn = await getServiceArn(service, cluster);
    await tagService(serviceArn, app, environment);
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

async function getServiceArn(service, cluster) {
  const command = new DescribeServicesCommand({
    cluster,
    services: [service],
  });

  const res = await ecsClient.send(command);
  if (res.services?.length < 1) throw `service ${service} not found`;

  return res.services[0].serviceArn;
}

async function tagService(arn, app, environment) {
  const command = new TagResourceCommand({
    resourceArn: arn,
    tags: [
      { key: "Waypoint", value: app },
      { key: "Environment", value: environment },
    ],
  });

  await ecsClient.send(command);
}
