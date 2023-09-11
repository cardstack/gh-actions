const hcl = require("hcl2-parser");
const core = require("@actions/core");
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
    const fileSystemId = core.getInput("file-system-id", { required: "true" });
    const accessPointId = core.getInput("access-point-id", { required: "true" });
    const mountPath = core.getInput("mount-path", { required: "true" });
    const volumeName = core.getInput("volume-name", { required: "true" });
    const waypointConfigFilePath = core.getInput("waypoint-hcl", { required: "true" });

    const { cluster } = getAppConfig(waypointConfigFilePath, app);

    ecsClient = new ECSClient();

    const serviceName = await getServiceName(app, project);
    const service = await getService(serviceName, cluster);

    let taskDefinition = await getTaskDefinition(service);
    if (taskDefinitionHasVolume(taskDefinition, volumeName, fileSystemId, accessPointId)) {
      console.log("Volume already attached");
      return;
    }

    taskDefinition = addVolumeToTaskDefinition(taskDefinition, volumeName, fileSystemId, accessPointId, mountPath);
    taskDefinition = await registerTaskDefinition(taskDefinition);

    await updateService(cluster, service, taskDefinition);
  } catch (err) {
    process.exitCode = 1;
    console.error(err);
  }
}

function taskDefinitionHasVolume(taskDefinition, name, fileSystemId, accessPointId) {
  if (taskDefinition.volumes?.length === 0) return false;

  const volume = taskDefinition.volumes.find((vol) => vol.name === name);

  return Boolean(
    volume?.efsVolumeConfiguration?.fileSystemId === fileSystemId &&
      volume.efsVolumeConfiguration.authorizationConfig?.accessPointId === accessPointId
  );
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

function addVolumeToTaskDefinition(taskDefinition, volumeName, fileSystemId, accessPointId, mountPath) {
  console.log(
    `Creating new task definition: adding EFS ${fileSystemId} with access point ${accessPointId} as volume ${volumeName} mounting at ${mountPath}`
  );

  taskDefinition.volumes.push({
    name: volumeName,
    efsVolumeConfiguration: {
      fileSystemId: fileSystemId,
      rootDirectory: "/",
      transitEncryption: "ENABLED",
      authorizationConfig: {
        accessPointId: accessPointId,
        iam: "ENABLED",
      },
    },
  });

  taskDefinition.containerDefinitions[0].mountPoints.push({
    containerPath: mountPath,
    sourceVolume: volumeName,
  });

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
