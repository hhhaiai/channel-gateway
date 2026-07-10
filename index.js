import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";

import { createChannelGatewayPlugin } from "./src/plugin.js";

export default createChannelGatewayPlugin({ dispatchGatewayMethod });
