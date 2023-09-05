const hcl = require("hcl2-parser");
const core = require("@actions/core");
const { readFileSync } = require("fs");
const { getExecOutput: exec } = require("@actions/exec");
const { DescribeServicesCommand, ECSClient } = require("@aws-sdk/client-ecs");
const {
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} = require("@aws-sdk/client-elastic-load-balancing-v2");

const ecsClient = new ECSClient();
const elbClient = new ElasticLoadBalancingV2Client();
let cluster = "";

main();

async function main() {
  try {
    const app = core.getInput("app", { required: "true" });
    const project = core.getInput("project", { required: "true" });
    const waypointConfigFilePath = core.getInput("waypoint-hcl");

    const cluster = getAppConfig(waypointConfigFilePath, app).cluster;
    const serviceName = await getServiceName(app, project);
    const service = await getService(serviceName, cluster);

    console.log("Waiting for service and target group to be ready...");
    await waitServiceRunning(service);
    if (serviceHasTargetGroup(service)) {
      waitTargetInService(service);
    }
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  }
}

async function getServiceName(app, project) {
  const { stdout } = await exec("waypoint", ["status", "-local", "-json", `-project=${project}`, `-app=${app}`]);
  const resources = JSON.parse(stdout).DeploymentResourcesSummary;
  const resource = resources.find((resource) => resource.Platform === "aws-ecs" && resource.Type === "service");
  return resource.Name;
}

function getAppConfig(waypointConfigFilePath, app) {
  const waypointHcl = readFileSync(waypointConfigFilePath, "utf8");
  const waypointConfig = hcl.parseToObject(waypointHcl)[0];
  const waypointApp = waypointConfig.app[app][0];
  const cluster = waypointApp.deploy[0].use["aws-ecs"][0].cluster;

  return { cluster };
}

async function getService(serviceName, cluster) {
  const command = new DescribeServicesCommand({
    services: [serviceName],
    cluster,
  });
  const res = await ecsClient.send(command);
  return res.services[0];
}

async function waitServiceRunning(service) {
  console.log(`Waiting until task in service is running: ${service.serviceName}`);
  let running = serviceHasRunningTask(service);
  let retry = 40;
  while (!running && retry > 0) {
    service = await getService(service.serviceName, service.clusterArn);
    running = serviceHasRunningTask(service);
    if (!running) {
      await sleep(15);
      retry--;
    }
  }
  if (!running) {
    throw "task(s) in service not running";
  }
  console.log(`Some tasks in service are running: ${service.serviceName}`);
}

function serviceHasRunningTask(service) {
  return service.deployments.find((deployment) => deployment.status === "PRIMARY").runningCount > 0;
}

function serviceHasTargetGroup(service) {
  return service.loadBalancers && service.loadBalancers.length > 0;
}

async function waitTargetInService(service) {
  const targetGroupArn = service.loadBalancers[0].targetGroupArn;
  const targetGroupName = targetGroupArn.split("/")[1];

  console.log(`Waiting until target in target group is in service: ${targetGroupName}`);
  let healthy = false;
  let retry = 40;
  while (!healthy && retry > 0) {
    const command = new DescribeTargetHealthCommand({
      TargetGroupArn: targetGroupArn,
    });
    const res = await elbClient.send(command);
    healthy = res.TargetHealthDescriptions.some((target) => target.TargetHealth.State === "healthy");
    if (!healthy) {
      await sleep(15);
      retry--;
    }
  }

  if (!healthy) {
    throw "target(s) in target group not healthy";
  }
  console.log(`Some targets in target group are in service: ${targetGroupName}`);
}

function sleep(seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}
