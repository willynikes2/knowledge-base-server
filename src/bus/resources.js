import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getBusResourceLimit } from './config.js';
import { listBusChannels, readBusChannel } from './service.js';

export function busChannelUri(channel) {
  return `bus://${encodeURIComponent(channel)}`;
}

export function registerBusResources(server) {
  server.resource(
    'bus-channel',
    new ResourceTemplate('bus://{channel}', {
      list: async () => ({
        resources: listBusChannels().map(channel => ({
          uri: busChannelUri(channel.channel),
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
    async (_uri, variables) => {
      const channel = decodeURIComponent(variables.channel);
      return {
        contents: [{
          uri: busChannelUri(channel),
          mimeType: 'application/json',
          text: JSON.stringify(readBusChannel(channel, getBusResourceLimit()), null, 2),
        }],
      };
    },
  );
}
