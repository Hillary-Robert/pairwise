// Must load before anything that touches Buffer or crypto.
import { install } from "react-native-quick-crypto";
import { Buffer } from "@craftzdog/react-native-buffer";

install();
(globalThis as any).Buffer ??= Buffer;
