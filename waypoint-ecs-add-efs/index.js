const hcl = require("hcl2-parser");
const core = require("@actions/core");
const yaml = require("yaml");
const { getExecOutput: exec } = require("@actions/exec");
const { readFileSync } = require("fs");
const {
  DescribeServicesCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  DescribeTaskDefinitionCommand,
} = require("@aws-sdk/client-ecs");

let ecsClient = null;
main();

async function main() {
  try {
    const app = core.getInput("app", { required: "true" });
    const project = core.getInput("project", { required: "true" });
    const waypointConfigFilePath = core.getInput("waypoint-hcl", { required: "true" });
    const configYAML = core.getInput("config", { required: "true" });

    const config = yaml.parse(configYAML);
    if (config.length === 0) {
      console.log("No volumes to add. Exiting...");
      return;
    }

    const { cluster } = getAppConfig(waypointConfigFilePath, app);

    ecsClient = new ECSClient();

    const serviceName = await getServiceName(app, project);
    const service = await getService(serviceName, cluster);

    let taskDefinition = await getTaskDefinition(service);
    if (taskDefinition.volumes && taskDefinition.volumes.length > 0) {
      throw "Task definition has volumes configured";
    }

    taskDefinition = addConfigToTaskDefinition(taskDefinition, config);
    taskDefinition = await registerTaskDefinition(taskDefinition);
    await updateService(cluster, service, taskDefinition);
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  }
}

async function getTaskDefinition(service) {
  console.log("Getting task definition from service...");

  const command = new DescribeTaskDefinitionCommand({
    taskDefinition: service.taskDefinition,
  });
  const res = await ecsClient.send(command);
  if (!res.taskDefinition) throw "taskDefinition not found";

  console.log(`Task definition found: ${res.taskDefinition.taskDefinitionArn}`);
  return res.taskDefinition;
}

async function registerTaskDefinition(taskDefinition) {
  console.log(`Registering new task definition`);

  const command = new RegisterTaskDefinitionCommand(taskDefinition);
  const res = await ecsClient.send(command);
  if (!res.taskDefinition || !res.taskDefinition.taskDefinitionArn) throw "error registering task definition";

  console.log(`New task definition registered: ${res.taskDefinition.taskDefinitionArn}`);
  return res.taskDefinition;
}

async function updateService(cluster, service, taskDefinition) {
  console.log(`Updating service: ${service.serviceName}`);

  const command = new UpdateServiceCommand({
    cluster,
    service: service.serviceName,
    taskDefinition: taskDefinition.taskDefinitionArn,
    forceNewDeployment: true,
  });
  await ecsClient.send(command);

  console.log(`Service updated: ${service.serviceName}`);
}

function addConfigToTaskDefinition(taskDefinition, config) {
  console.log("Creating new task definition...");

  taskDefinition.volumes = config.map((volume) => ({
    name: volume.name,
    efsVolumeConfiguration: {
      fileSystemId: volume.id,
      rootDirectory: "/",
      transitEncryption: "ENABLED",
      authorizationConfig: {
        accessPointId: volume["access-point"],
        iam: "ENABLED",
      },
    },
  }));

  let mountPoints = {};
  for (const volume of config) {
    for (const mount of volume.mounts) {
      if (!mountPoints[mount.container]) mountPoints[mount.container] = [];
      mountPoints[mount.container].push({
        sourceVolume: volume.name,
        containerPath: mount.path,
      });
    }
  }

  for (const [name, mp] of Object.entries(mountPoints)) {
    const index = taskDefinition.containerDefinitions.findIndex(
      (containerDefinition) => containerDefinition.name === name
    );

    if (index < 0) throw `container definition for '${name}' not found`;
    taskDefinition.containerDefinitions[index].mountPoints = mp;
  }

  // Remove post-deployment attributes from the fetched task definition, they cannot be specified in a new one
  delete taskDefinition.taskDefinitionArn;
  delete taskDefinition.revision;
  delete taskDefinition.status;
  delete taskDefinition.requiresAttributes;
  delete taskDefinition.compatibilities;
  delete taskDefinition.registeredAt;
  delete taskDefinition.registeredBy;

  return taskDefinition;
}

async function getServiceName(app, project) {
  const { stdout } = await exec("waypoint", ["status", "-local", "-json", `-project=${project}`, `-app=${app}`]);
  const output = stdout.replace(/^[^{]*{/, "{");
  const resources = JSON.parse(output).DeploymentResourcesSummary;
  const resource = resources.find((resource) => resource.Platform === "aws-ecs" && resource.Type === "service");
  return resource.Name;
}

async function getService(serviceName, cluster) {
  const command = new DescribeServicesCommand({
    services: [serviceName],
    cluster,
  });

  const res = await ecsClient.send(command);
  if (!res.services || res.services.length < 1) throw `service ${serviceName} not found`;

  return res.services[0];
}

function getAppConfig(waypointConfigFilePath, app) {
  const waypointHcl = readFileSync(waypointConfigFilePath, "utf8");
  const waypointConfig = hcl.parseToObject(waypointHcl)[0];
  const waypointApp = waypointConfig.app[app][0];
  const cluster = waypointApp.deploy[0].use["aws-ecs"][0].cluster;

  return { cluster };
}
