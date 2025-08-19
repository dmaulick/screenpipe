// "use client";

import { ObsidianSettings } from "@/components/obsidian-settings";
import { Zap } from "lucide-react";

export default function Page() {
  return (
    <div className="flex flex-col gap-4 items-center justify-center h-full mt-12">
      
      <div className="flex items-center gap-2">
							<div className="w-8 h-8 juno-gradient rounded-lg flex items-center justify-center">
								<Zap className="w-5 h-5 text-white" />
							</div>
							<span className="text-2xl font-bold">Juno</span>
						</div>
      <p className="text-xl font-bold">Your knowledge base on autopilot</p>
      <ObsidianSettings />
    </div>
  );
}
