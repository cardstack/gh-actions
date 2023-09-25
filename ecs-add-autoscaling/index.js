//import core from "@actions/core";
import { getExecOutput as exec } from "@actions/exec";
import {
  ApplicationAutoScalingClient,
  RegisterScalableTargetCommand,
  PutScalingPolicyCommand,
} from "@aws-sdk/client-application-auto-scaling";

const autoScalingClient = new ApplicationAutoScalingClient();

main();

async function main() {
  try {
    //const app = core.getInput("app", { required: "true" });
    //const project = core.getInput("project", { required: "true" });
    //const minString = core.getInput("min", { required: "true" });
    //const maxString = core.getInput("max", { required: "true" });

    const app = "cavy";
    const project = "cardstack";
    const minString = "1";
    const maxString = "3";

    const min = parseInt(minString);
    const max = parseInt(maxString);

    const { service, cluster } = await getWaypointResources(app, project);

    console.log(`Registering ECS service as scalable target: ${service}`);
    const scalableTargetArn = await registerScalableTarget(service, cluster, min, max);
    console.log(`Scalable target registered: ${scalableTargetArn}`);

    console.log(`Adding CPU scaling policy for service: ${service}`);
    const cpuScalingPolicyArn = await putScalingPolicy(
      `${service}-cpu`,
      service,
      cluster,
      "ECSServiceAverageCPUUtilization"
    );
    console.log(`CPU scaling policy added: ${cpuScalingPolicyArn}`);

    console.log(`Adding memory scaling policy for service: ${service}`);
    const memScalingPolicyArn = await putScalingPolicy(
      `${service}-mem`,
      service,
      cluster,
      "ECSServiceAverageMemoryUtilization"
    );
    console.log(`Memory scaling policy added: ${memScalingPolicyArn}`);
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

async function registerScalableTarget(service, cluster, min, max) {
  const command = new RegisterScalableTargetCommand({
    ResourceId: `service/${cluster}/${service}`,
    MaxCapacity: max,
    MinCapacity: min,
    ScalableDimension: "ecs:service:DesiredCount",
    ServiceNamespace: "ecs",
  });
  const res = await autoScalingClient.send(command);
  return res.ScalableTargetARN;
}

async function putScalingPolicy(name, service, cluster, metric) {
  const command = new PutScalingPolicyCommand({
    PolicyName: name,
    ResourceId: `service/${cluster}/${service}`,
    ScalableDimension: "ecs:service:DesiredCount",
    ServiceNamespace: "ecs",
    PolicyType: "TargetTrackingScaling",
    TargetTrackingScalingPolicyConfiguration: {
      TargetValue: 75,
      PredefinedMetricSpecification: {
        PredefinedMetricType: metric,
      },
    },
  });
  const res = await autoScalingClient.send(command);
  return res.PolicyARN;
}
