import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getBusResourceLimit } from './config.js';
import { listBusChannels, readBusChannel } from './service.js';

export function registerBusResources(server) {
  server.resource(
    'bus-channel',
    new ResourceTemplate('bus://{channel}', {
      list: async () => ({
        resources: listBusChannels().map(channel => ({
          uri: `bus://${channel.channel}`,
          name: `bus:${channel.channel}`,
          mimeType: 'application/json',
          description: `${channel.message_count} message(s), latest id ${channel.latest_id}`,
        })),
      }),
    }),
    {
      title: 'Message bus channel',
      description: 'Read the latest messages for a local agent-to-agent bus channel.',
      mimeType: 'application/json',
    },
    async (_uri, variables) => ({
      contents: [{
        uri: `bus://${variables.channel}`,
        mimeType: 'application/json',
        text: JSON.stringify(readBusChannel(variables.channel, getBusResourceLimit()), null, 2),
      }],
    }),
  );
}
