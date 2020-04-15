const fs = require('fs')
const { Component } = require('@serverless/core')
const { generateId, targzip, monitorPod } = require('./utils')
const {
  deployKubernetesConfigMap,
  deployKnativeServing,
  deployKubernetesNamespace,
  deployKubernetesPod,
  deployKubernetesPVC,
  execKubernetesPod,
  readKubernetesPod,
  removeKubernetesNamespace,
  removeKubernetesPod
} = require('./knative')

class Express extends Component {
  async deploy(inputs) {
    console.log(`Deploying Express App...`)

    // Extracting the necessary credentials at a single place
    const DOCKER_USERNAME = this.credentials.docker.username
    const DOCKER_AUTH = this.credentials.docker.auth

    const appName = this.name

    const defaults = {
      prefix: `${appName}-${generateId()}`
    }

    const config = {
      ...defaults,
      ...inputs,
      ...this.state
    }

    // 1. Ensure K8S Namespace
    if (!config.namespace) {
      console.log('Deploying K8S Namespace...')
      const ns = await deployKubernetesNamespace.call(this, {
        name: config.prefix
      })
      config.namespace = ns.name
    }
    const { namespace } = config
    this.state = config // Saving state...

    // 2. Ensure K8S ConfigMap which serves the Docker credentials
    console.log('Deploying K8S ConfigMap...')
    const cm = await deployKubernetesConfigMap.call(this, {
      namespace,
      name: 'docker-config',
      data: {
        'config.json': `{ "auths": { "https://index.docker.io/v1/": { "auth": "${DOCKER_AUTH}" } } }`
      }
    })
    const configMapName = cm.name

    // 3. Ensure K8S PersistentVolumeClaim which
    console.log('Ensuring K8S PersistentVolumeClaim...')
    const pvc = await deployKubernetesPVC.call(this, {
      namespace,
      name: `${config.prefix}-fs-pvc`,
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: {
            storage: '10Gi'
          }
        }
      }
    })
    const pvcName = pvc.name
    this.state = config // Saving state...

    // 4. Ensure K8S Pod (is used for file storage of e.g. Docker build context)
    const fsPodName = `${config.prefix}-fs`
    const fsContainerName = `${fsPodName}-container`
    const fsVolumeMountPath = '/data'
    let fsPodExists = true
    console.log(`Ensuring K8S "${fsPodName}" Pod...`)
    // Check if Pod is already in place
    try {
      await readKubernetesPod.call(this, {
        namespace,
        name: fsPodName
      })
    } catch (error) {
      fsPodExists = error.response.body.code === 404 ? false : true
    }
    // If it's not there yet, create it...
    if (!fsPodExists) {
      await deployKubernetesPod.call(this, {
        namespace,
        name: fsPodName,
        spec: {
          containers: [
            {
              name: fsContainerName,
              // NOTE: This can be any image as long as it ships with `tar`
              image: 'ubuntu:latest',
              command: ['tail', '-f', '/dev/null'], // Run container forever
              volumeMounts: [
                // Mounting our PersistentVolumeClaim
                {
                  name: 'data',
                  mountPath: fsVolumeMountPath
                }
              ]
            }
          ],
          volumes: [
            // Referencing our PersistentVolumeClaim
            {
              name: 'data',
              persistentVolumeClaim: {
                claimName: pvcName
              }
            }
          ]
        }
      })
      // Monitor until the Pod is ready
      await monitorPod.call(this, namespace, fsPodName, 'Running')
    }
    this.state = config // Saving state...

    // 5. Create tar of source code
    // HACK: Here we're basically working around the problem that we need a `tar.gz` file
    //   while Serverless Components only support `.zip` files.
    // NOTE: We need to use `this.src` here, otherwise we might reference
    //   something invalid due to weird state savings when deployments fail halfway through
    const unzippedSrcDirPath = await this.unzip(inputs.src)
    const tarFileName = `${config.prefix}.tar.gz`
    const tarResult1 = await targzip(unzippedSrcDirPath, tarFileName)
    // NOTE: We need to double tar it because we're using `tar` via exec to transfer the file to a Pod
    const tarResult2 = await targzip(tarResult1.destPath, tarFileName)
    this.state = config // Saving state...

    // 6. Upload `.tar.gz` file to our "File Storage" Pod
    console.log(`Uploading file "${tarResult2.filePath}" to "${fsPodName}"...`)
    const stdin = fs.createReadStream(tarResult2.filePath)
    await execKubernetesPod.call(this, {
      namespace,
      name: fsPodName,
      command: ['tar', '-xzf', '-', '-C', fsVolumeMountPath],
      container: fsContainerName,
      stdin,
      stdout: null,
      stderr: null
    })
    this.state = config // Saving state...

    // 7. Run Kaniko via K8S Pod
    // HACK: Using a random Number as a tag forces a Knative Serving re-deployment
    //   We should use a checksum of the tarball later on
    // NOTE: We give every pod a unique name so that Pod removal can fail silently later on
    //   (once something goes wrong. It will eventually be cleaned-up when the K8S Namespace is removed)
    const dockerTag = generateId()
    const kanikoPodName = `${config.prefix}-${dockerTag}-kaniko`
    const kanikoContainerName = `${kanikoPodName}-container`
    console.log(`Running K8S "${kanikoPodName}" Pod...`)
    const dockerRepo = `${DOCKER_USERNAME}/${appName}`
    await deployKubernetesPod.call(this, {
      namespace,
      name: kanikoPodName,
      spec: {
        containers: [
          {
            name: kanikoContainerName,
            // NOTE: We have to use a custom image here because OpenShift doesn't allow
            // containers to run as root which is required by `kaniko` ATM
            image: 'gcr.io/kaniko-project/executor:latest',
            args: [
              `--dockerfile=Dockerfile`,
              `--context=tar://${fsVolumeMountPath}/${tarFileName}`,
              `--destination=${dockerRepo}:${dockerTag}`
            ],
            volumeMounts: [
              // Mounting our Docker config via our ConfigMap
              {
                name: `${configMapName}`,
                mountPath: '/kaniko/.docker/'
              },
              // Mounting our PersistentVolumeClaim
              {
                name: 'data',
                mountPath: fsVolumeMountPath
              }
            ]
          }
        ],
        restartPolicy: 'Never',
        volumes: [
          {
            name: `${configMapName}`,
            configMap: {
              name: `${configMapName}`
            }
          },
          // Referencing our PersistentVolumeClaim
          {
            name: 'data',
            persistentVolumeClaim: {
              claimName: pvcName
            }
          }
        ]
      }
    })
    // Monitor until the Pod is ready
    await monitorPod.call(this, namespace, kanikoPodName)
    this.state = config // Saving state...

    // 8. Remove "old" Kaniko Pod
    // HACK: We should automate this via Tekton Pipelines later on
    console.log(`Removing K8S "${kanikoPodName}" Pod...`)
    try {
      await removeKubernetesPod.call(this, {
        namespace,
        name: kanikoPodName
      })
    } catch (error) {
      console.log(`Removal of Pod "${kanikoPodName} failed with error ${error.message}"...`)
      console.log("Not an issue since it'll be cleaned up when the Namespace is removed...")
    }
    this.state = config // Saving state...

    // 9. Deploy Knative Serving service
    console.log('Deploying Knative Serving...')
    const knativeServingName = `${config.prefix}-knative`
    const knative = await deployKnativeServing.call(this, {
      namespace,
      name: knativeServingName,
      repository: dockerRepo,
      tag: dockerTag
    })
    config.serviceUrl = knative.serviceUrl

    this.state = config // Saving state...
    return this.state
  }

  async remove() {
    const config = {
      ...this.state
    }

    // 1. Remove the K8S Namespace
    console.log('Removing K8S Namespace...')
    await removeKubernetesNamespace.call(this, { name: config.namespace })

    this.state = {}
    return {}
  }
}

module.exports = Express
