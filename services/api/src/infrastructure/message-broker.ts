import amqp, { ConfirmChannel } from "amqplib";
import { config } from "../config";

export const TASK_QUEUE = "tasks";
export const RESULT_QUEUE = "results";

let channelPromise: Promise<ConfirmChannel> | null = null;

/** RabbitMQ can pass its health check slightly before it accepts connections, so retry. */
async function connectWithRetry(maxAttempts = 30): Promise<amqp.ChannelModel> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await amqp.connect(config.rabbitmqUrl);
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function openChannel(): Promise<ConfirmChannel> {
  const connection = await connectWithRetry();
  const forgetChannel = () => {
    channelPromise = null; // the next getChannel() call reconnects
  };
  connection.on("close", forgetChannel);
  connection.on("error", forgetChannel);
  // A confirm channel lets publish() wait until the broker has stored the message.
  const channel = await connection.createConfirmChannel();
  channel.on("error", (err) => console.error("message broker channel error:", err.message));
  channel.on("close", () => {
    forgetChannel();
    connection.close().catch(() => undefined); // do not leak the connection of a dead channel
  });
  await channel.assertQueue(TASK_QUEUE, { durable: true });
  await channel.assertQueue(RESULT_QUEUE, { durable: true });
  return channel;
}

/** One shared channel per process. */
export function getChannel(): Promise<ConfirmChannel> {
  if (!channelPromise) {
    channelPromise = openChannel().catch((err) => {
      channelPromise = null;
      throw err;
    });
  }
  return channelPromise;
}

/** Publish a persistent message and resolve only after the broker confirms it. */
export async function publish(queue: string, message: object): Promise<void> {
  const channel = await getChannel();
  await new Promise<void>((resolve, reject) => {
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), { persistent: true }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}
