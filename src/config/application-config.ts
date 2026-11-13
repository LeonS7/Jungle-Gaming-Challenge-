/**
 * Esta página carrega e valida a configuração necessária antes da inicialização.
 * Assinatura: Leonardo de Souza da Luz
 */
export interface ApplicationConfig {
  readonly appPort: number;
  readonly postgres: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
  };
  readonly sqs: {
    readonly region: string;
    readonly endpoint: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly queueName: string;
    readonly deadLetterQueueName: string;
  };
}

type Environment = Readonly<Record<string, string | undefined>>;

function requiredString(environment: Environment, key: string): string {
  const value = environment[key]?.trim();
  if (!value) {
    throw new Error(`A variável de ambiente obrigatória ${key} não foi informada.`);
  }

  return value;
}

function requiredPort(environment: Environment, key: string): number {
  const rawValue = requiredString(environment, key);
  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${key} deve ser um número inteiro entre 1 e 65535.`);
  }

  return value;
}

function requiredHttpEndpoint(environment: Environment, key: string): string {
  const value = requiredString(environment, key);

  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error('O protocolo não é suportado.');
    }
  } catch {
    throw new Error(`${key} deve ser uma URL HTTP ou HTTPS válida.`);
  }

  return value;
}

export function loadApplicationConfig(
  environment: Environment = process.env,
): ApplicationConfig {
  return {
    appPort: requiredPort(environment, 'APP_PORT'),
    postgres: {
      host: requiredString(environment, 'DATABASE_HOST'),
      port: requiredPort(environment, 'DATABASE_PORT'),
      database: requiredString(environment, 'DATABASE_NAME'),
      user: requiredString(environment, 'DATABASE_USER'),
      password: requiredString(environment, 'DATABASE_PASSWORD'),
    },
    sqs: {
      region: requiredString(environment, 'AWS_REGION'),
      endpoint: requiredHttpEndpoint(environment, 'AWS_ENDPOINT'),
      accessKeyId: requiredString(environment, 'AWS_ACCESS_KEY_ID'),
      secretAccessKey: requiredString(environment, 'AWS_SECRET_ACCESS_KEY'),
      queueName: requiredString(environment, 'SQS_QUEUE_NAME'),
      deadLetterQueueName: requiredString(environment, 'SQS_DLQ_QUEUE_NAME'),
    },
  };
}
