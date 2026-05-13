import Docker from 'dockerode';

export const createDockerClient = (): Docker => {
  // Defaults: connect via DOCKER_HOST env or /var/run/docker.sock.
  return new Docker();
};

export type { Docker };
