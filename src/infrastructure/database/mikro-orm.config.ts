import { AppConfig } from "../config/app-config";
import { createMikroOrmOptions } from "./mikro-orm.options";

export default createMikroOrmOptions(AppConfig.fromEnv(process.env));
