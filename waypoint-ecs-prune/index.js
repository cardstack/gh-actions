import * as core from "@actions/core";
import { getExecOutput as exec } from "@actions/exec";
import {
  DeleteServiceCommand,
  DescribeServicesCommand,
  ECSClient,
  ListServicesCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-ecs";
import {
  DeleteTargetGroupCommand,
  DescribeListenersCommand,
  DescribeTargetGroupsCommand,
  ElasticLoadBalancingV2Client,
  ModifyListenerCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2";

let ecsClient = new ECSClient();
let elbClient = new ElasticLoadBalancingV2Client();

main();

async function main() {
  try {
    const app = core.getInput("app", { required: "true" });
    const project = core.getInput("project", { required: "true" });
    const environment = core.getInput("environment", { required: "true" });

    const { service: serviceName, cluster } = await getWaypointResources(app, project);
    const currentService = await getService(serviceName, cluster);
    const serviceArns = await getServices(cluster, app, environment);

    for (const serviceArn of serviceArns) {
      if (serviceArn === currentService.serviceArn) continue;

      const service = await getService(serviceArn, cluster);
      const targetGroupArns = service.loadBalancers.map((lb) => lb.targetGroupArn);

      await deleteService(service.serviceName, cluster);
      for (const arn of targetGroupArns) {
        const targetGroup = await getTargetGroup(arn);
        await removeTargetGroupFromListener(targetGroup);
        await deleteTargetGroup(arn);
      }
    }
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

async function getService(serviceName, cluster) {
  const command = new DescribeServicesCommand({
    cluster,
    services: [serviceName],
  });

  const res = await ecsClient.send(command);
  if (res.services.length <= 0) throw `service ${serviceName} not found`;

  return res.services[0];
}

async function getServices(cluster, app, environment) {
  let nextToken = null;
  let serviceArns = [];

  while (true) {
    let option = {
      cluster,
      maxResults: 100,
    };
    if (nextToken) option.nextToken = nextToken;

    const command = new ListServicesCommand(option);
    const res = await ecsClient.send(command);

    serviceArns = serviceArns.concat(res.serviceArns);

    if (!res.nextToken) break;
    nextToken = res.nextToken;
  }

  let serviceArnsFiltered = [];
  for (const arn of serviceArns) {
    const command = new ListTagsForResourceCommand({
      resourceArn: arn,
    });
    const res = await ecsClient.send(command);

    const matchApp = res.tags.some((tag) => tag.key === "Waypoint" && tag.value === app);
    const matchEnv = res.tags.some((tag) => tag.key === "Environment" && tag.value === environment);

    if (matchApp && matchEnv) {
      serviceArnsFiltered.push(arn);
    }
  }

  return serviceArnsFiltered;
}

async function getTargetGroup(arn) {
  const command = new DescribeTargetGroupsCommand({
    TargetGroupArns: [arn],
  });
  const res = await elbClient.send(command);
  if (res.TargetGroups.length <= 0) throw `target group not found: ${arn}`;

  return res.TargetGroups[0];
}

async function removeTargetGroupFromListener(targetGroup) {
  if (targetGroup.LoadBalancerArns.length <= 0) return;

  const lbArn = targetGroup.LoadBalancerArns[0];
  console.log(`Removing target group from load balancer: ${lbArn}`);

  const targetGroupArn = targetGroup.TargetGroupArn;

  const listeners = await getListeners(lbArn);
  for (const listener of listeners) {
    if (listener.DefaultActions.length !== 1 || listener.DefaultActions[0].Type !== "forward") continue;

    const targetGroups = listener.DefaultActions[0].ForwardConfig.TargetGroups;
    const tg = targetGroups.find((t) => t.TargetGroupArn === targetGroupArn);
    if (!tg) continue;

    if (tg.Weight > 0) throw `target group is active: ${targetGroup.TargetGroupArn}`;

    console.log(`Modifying listener to remove target group: ${listener.ListenerArn}`);
    const command = new ModifyListenerCommand({
      ListenerArn: listener.ListenerArn,
      DefaultActions: [
        {
          ForwardConfig: {
            TargetGroups: targetGroups.filter((t) => t.TargetGroupArn !== targetGroupArn),
          },
          Type: "forward",
        },
      ],
    });
    await elbClient.send(command);
  }
}

async function getListeners(loadBalancerArn) {
  const command = new DescribeListenersCommand({
    LoadBalancerArn: loadBalancerArn,
  });
  const res = await elbClient.send(command);
  return res.Listeners;
}

async function deleteTargetGroup(arn) {
  console.log(`Deleting target group: ${arn}`);
  const command = new DeleteTargetGroupCommand({
    TargetGroupArn: arn,
  });
  await elbClient.send(command);
}

async function deleteService(serviceName, cluster) {
  console.log(`Deleting service: ${serviceName}`);
  const command = new DeleteServiceCommand({
    service: serviceName,
    cluster,
    force: true,
  });
  await ecsClient.send(command);
}
