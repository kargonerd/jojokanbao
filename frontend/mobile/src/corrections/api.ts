import { createContentCorrectionRepository } from "@jojo/auth";
import { mobileAuthClient } from "../account/auth";

export const mobileContentCorrections = createContentCorrectionRepository(mobileAuthClient);
