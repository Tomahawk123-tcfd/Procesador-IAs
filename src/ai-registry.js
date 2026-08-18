export var AI_CATEGORIES = ['text', 'code', 'vision', 'image', 'audio', 'reasoning', 'multimodal', 'embedding', 'video', 'music'];

export var AI_REGISTRY = [
  // ═══ TEXT MODELS ═══
  { id: 'claude-fable-5', name: 'Claude Fable 5', provider: 'anthropic', category: 'text', elo: 1382, bestFor: ['writing', 'analysis', 'reasoning', 'creative'], openSource: false },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', provider: 'anthropic', category: 'text', elo: 1375, bestFor: ['reasoning', 'code', 'analysis', 'long-context'], openSource: false },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'anthropic', category: 'text', elo: 1357, bestFor: ['reasoning', 'code', 'analysis'], openSource: false },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', category: 'text', elo: 1350, bestFor: ['reasoning', 'analysis'], openSource: false },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', category: 'text', elo: 1340, bestFor: ['code', 'analysis', 'balanced'], openSource: false },
  { id: 'claude-sonnet-4-4', name: 'Claude Sonnet 4.4', provider: 'anthropic', category: 'text', elo: 1335, bestFor: ['code', 'analysis'], openSource: false },
  { id: 'claude-haiku-4', name: 'Claude Haiku 4', provider: 'anthropic', category: 'text', elo: 1310, bestFor: ['fast', 'balanced'], openSource: false },
  { id: 'claude-haiku-3-5', name: 'Claude Haiku 3.5', provider: 'anthropic', category: 'text', elo: 1290, bestFor: ['fast', 'cheap'], openSource: false },
  { id: 'gpt-5-6-sol', name: 'GPT 5.6 Sol', provider: 'openai', category: 'text', elo: 1378, bestFor: ['code', 'reasoning', 'math', 'analysis'], openSource: false },
  { id: 'gpt-5-5', name: 'GPT 5.5', provider: 'openai', category: 'text', elo: 1360, bestFor: ['general', 'writing', 'analysis'], openSource: false },
  { id: 'gpt-5-4', name: 'GPT 5.4', provider: 'openai', category: 'text', elo: 1355, bestFor: ['general', 'analysis'], openSource: false },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', category: 'text', elo: 1330, bestFor: ['general', 'multimodal'], openSource: false },
  { id: 'gpt-4o-mini', name: 'GPT-4o-mini', provider: 'openai', category: 'text', elo: 1280, bestFor: ['fast', 'cheap'], openSource: false },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai', category: 'text', elo: 1320, bestFor: ['general', 'long-context'], openSource: false },
  { id: 'o3', name: 'o3', provider: 'openai', category: 'reasoning', elo: 1390, bestFor: ['math', 'code', 'reasoning'], openSource: false },
  { id: 'o3-mini', name: 'o3-mini', provider: 'openai', category: 'reasoning', elo: 1365, bestFor: ['math', 'code', 'reasoning'], openSource: false },
  { id: 'o4-mini', name: 'o4-mini', provider: 'openai', category: 'reasoning', elo: 1370, bestFor: ['math', 'code', 'reasoning'], openSource: false },
  { id: 'gemini-3-1-pro', name: 'Gemini 3.1 Pro', provider: 'google', category: 'multimodal', elo: 1368, bestFor: ['multimodal', 'search', 'analysis', 'coding'], openSource: false },
  { id: 'gemini-3-0-pro', name: 'Gemini 3.0 Pro', provider: 'google', category: 'multimodal', elo: 1360, bestFor: ['multimodal', 'analysis'], openSource: false },
  { id: 'gemini-2-5-pro', name: 'Gemini 2.5 Pro', provider: 'google', category: 'multimodal', elo: 1350, bestFor: ['multimodal', 'reasoning'], openSource: false },
  { id: 'gemini-2-5-flash', name: 'Gemini 2.5 Flash', provider: 'google', category: 'text', elo: 1335, bestFor: ['fast', 'balanced'], openSource: false },
  { id: 'gemini-2-0-flash', name: 'Gemini 2.0 Flash', provider: 'google', category: 'text', elo: 1320, bestFor: ['fast', 'search'], openSource: false },
  { id: 'gemini-1-5-pro', name: 'Gemini 1.5 Pro', provider: 'google', category: 'text', elo: 1310, bestFor: ['long-context', 'analysis'], openSource: false },
  { id: 'gemini-nano-2', name: 'Gemini Nano 2', provider: 'google', category: 'text', elo: 1100, bestFor: ['on-device', 'fast'], openSource: false },
  { id: 'kimi-k3', name: 'Kimi K3', provider: 'moonshot', category: 'text', elo: 1371, bestFor: ['code', 'math', 'reasoning'], openSource: false },
  { id: 'kimi-k2', name: 'Kimi K2', provider: 'moonshot', category: 'text', elo: 1350, bestFor: ['code', 'reasoning'], openSource: false },
  { id: 'kimi-k1-5', name: 'Kimi K1.5', provider: 'moonshot', category: 'text', elo: 1330, bestFor: ['reasoning'], openSource: false },
  { id: 'glm-5-2', name: 'GLM 5.2', provider: 'zhipu', category: 'text', elo: 1364, bestFor: ['reasoning', 'math', 'chinese'], openSource: false },
  { id: 'glm-5-1', name: 'GLM 5.1', provider: 'zhipu', category: 'text', elo: 1355, bestFor: ['reasoning', 'finance'], openSource: false },
  { id: 'glm-4', name: 'GLM 4', provider: 'zhipu', category: 'text', elo: 1330, bestFor: ['general'], openSource: false },
  { id: 'glm-4-9b', name: 'GLM-4-9B', provider: 'zhipu', category: 'text', elo: 1280, bestFor: ['general', 'open-source'], openSource: true, repo: 'THUDM/glm-4' },
  { id: 'grok-4', name: 'Grok 4', provider: 'xai', category: 'text', elo: 1350, bestFor: ['real-time', 'search', 'analysis'], openSource: false },
  { id: 'grok-3', name: 'Grok 3', provider: 'xai', category: 'text', elo: 1340, bestFor: ['real-time', 'analysis'], openSource: false },
  { id: 'grok-3-mini', name: 'Grok 3 Mini', provider: 'xai', category: 'text', elo: 1320, bestFor: ['fast', 'real-time'], openSource: false },
  { id: 'qwen-3-5-max', name: 'Qwen 3.5 Max', provider: 'alibaba', category: 'text', elo: 1353, bestFor: ['code', 'math', 'multilingual'], openSource: false },
  { id: 'qwen-3-5-plus', name: 'Qwen 3.5 Plus', provider: 'alibaba', category: 'text', elo: 1340, bestFor: ['code', 'balanced'], openSource: false },
  { id: 'qwen-3-235b', name: 'Qwen 3 235B', provider: 'alibaba', category: 'text', elo: 1335, bestFor: ['code', 'reasoning'], openSource: true, repo: 'QwenLM/Qwen3' },
  { id: 'qwen-2-5-72b', name: 'Qwen 2.5 72B', provider: 'alibaba', category: 'text', elo: 1310, bestFor: ['general', 'code'], openSource: true, repo: 'QwenLM/Qwen2.5' },
  { id: 'qwen-2-5-7b', name: 'Qwen 2.5 7B', provider: 'alibaba', category: 'text', elo: 1260, bestFor: ['fast', 'general'], openSource: true, repo: 'QwenLM/Qwen2.5' },
  { id: 'mistral-large-2', name: 'Mistral Large 2', provider: 'mistral', category: 'text', elo: 1340, bestFor: ['general', 'code'], openSource: false },
  { id: 'mistral-medium', name: 'Mistral Medium', provider: 'mistral', category: 'text', elo: 1310, bestFor: ['general', 'balanced'], openSource: false },
  { id: 'mistral-small', name: 'Mistral Small', provider: 'mistral', category: 'text', elo: 1290, bestFor: ['fast', 'legal'], openSource: false },
  { id: 'mixtral-8x22b', name: 'Mixtral 8x22B', provider: 'mistral', category: 'text', elo: 1300, bestFor: ['general', 'code'], openSource: true, repo: 'mistralai/mixtral' },
  { id: 'mixtral-8x7b', name: 'Mixtral 8x7B', provider: 'mistral', category: 'text', elo: 1270, bestFor: ['fast', 'general'], openSource: true, repo: 'mistralai/mixtral' },
  { id: 'codestral', name: 'Codestral', provider: 'mistral', category: 'code', elo: 1345, bestFor: ['code', 'code-gen'], openSource: false },
  { id: 'deepseek-v4', name: 'DeepSeek V4', provider: 'deepseek', category: 'text', elo: 1360, bestFor: ['code', 'math', 'reasoning'], openSource: true, repo: 'deepseek-ai/DeepSeek-V4' },
  { id: 'deepseek-v3', name: 'DeepSeek V3', provider: 'deepseek', category: 'text', elo: 1340, bestFor: ['code', 'reasoning'], openSource: true, repo: 'deepseek-ai/DeepSeek-V3' },
  { id: 'deepseek-r1', name: 'DeepSeek R1', provider: 'deepseek', category: 'reasoning', elo: 1355, bestFor: ['reasoning', 'math', 'code'], openSource: true, repo: 'deepseek-ai/DeepSeek-R1' },
  { id: 'deepseek-coder-v2', name: 'DeepSeek Coder V2', provider: 'deepseek', category: 'code', elo: 1330, bestFor: ['code', 'coding'], openSource: true, repo: 'deepseek-ai/DeepSeek-Coder-V2' },
  { id: 'llama-4-maverick', name: 'Llama 4 Maverick 17B', provider: 'meta', category: 'text', elo: 1340, bestFor: ['writing', 'creative', 'open-source'], openSource: true, repo: 'meta-llama/llama-models' },
  { id: 'llama-4-scout', name: 'Llama 4 Scout', provider: 'meta', category: 'text', elo: 1325, bestFor: ['general', 'open-source'], openSource: true, repo: 'meta-llama/llama-models' },
  { id: 'llama-3-3-70b', name: 'Llama 3.3 70B', provider: 'meta', category: 'text', elo: 1310, bestFor: ['general', 'code'], openSource: true, repo: 'meta-llama/llama-models' },
  { id: 'llama-3-1-405b', name: 'Llama 3.1 405B', provider: 'meta', category: 'text', elo: 1320, bestFor: ['general', 'reasoning'], openSource: true, repo: 'meta-llama/llama-models' },
  { id: 'llama-3-1-70b', name: 'Llama 3.1 70B', provider: 'meta', category: 'text', elo: 1295, bestFor: ['general', 'code'], openSource: true, repo: 'meta-llama/llama-models' },
  { id: 'llama-3-1-8b', name: 'Llama 3.1 8B', provider: 'meta', category: 'text', elo: 1250, bestFor: ['fast', 'general'], openSource: true, repo: 'meta-llama/llama-models' },
  { id: 'llama-3-2-3b', name: 'Llama 3.2 3B', provider: 'meta', category: 'text', elo: 1200, bestFor: ['fast', 'on-device'], openSource: true, repo: 'meta-llama/llama-models' },
  { id: 'llama-3-2-1b', name: 'Llama 3.2 1B', provider: 'meta', category: 'text', elo: 1150, bestFor: ['fast', 'on-device'], openSource: true, repo: 'meta-llama/llama-models' },
  { id: 'nemotron-4-340b', name: 'Nemotron 4 340B', provider: 'nvidia', category: 'text', elo: 1330, bestFor: ['general', 'marketing'], openSource: true, repo: 'NVIDIA/Nemotron-4-340B' },
  { id: 'nemotron-3-ultra-550b', name: 'Nemotron 3 Ultra 550B', provider: 'nvidia', category: 'text', elo: 1325, bestFor: ['general', 'analysis'], openSource: true, repo: 'NVIDIA/Nemotron-3-Ultra-550B' },
  { id: 'nemotron-mini', name: 'Nemotron Mini', provider: 'nvidia', category: 'text', elo: 1260, bestFor: ['fast', 'general'], openSource: true, repo: 'NVIDIA/Nemotron-Mini' },
  { id: 'command-r-plus', name: 'Command R+', provider: 'cohere', category: 'text', elo: 1310, bestFor: ['RAG', 'search', 'analysis'], openSource: false },
  { id: 'command-r', name: 'Command R', provider: 'cohere', category: 'text', elo: 1280, bestFor: ['RAG', 'fast'], openSource: false },
  { id: 'dbrx', name: 'DBRX', provider: 'databricks', category: 'text', elo: 1290, bestFor: ['general', 'code'], openSource: true, repo: 'databricks/dbrx' },
  { id: 'yi-1-5-34b', name: 'Yi-1.5 34B', provider: '01-ai', category: 'text', elo: 1280, bestFor: ['general', 'multilingual'], openSource: true, repo: '01-ai/Yi-1.5' },
  { id: 'yi-1-5-9b', name: 'Yi-1.5 9B', provider: '01-ai', category: 'text', elo: 1240, bestFor: ['fast', 'general'], openSource: true, repo: '01-ai/Yi-1.5' },
  { id: 'yi-lightning', name: 'Yi-Lightning', provider: '01-ai', category: 'text', elo: 1320, bestFor: ['fast', 'general'], openSource: false },
  { id: 'yi-large', name: 'Yi-Large', provider: '01-ai', category: 'text', elo: 1300, bestFor: ['general'], openSource: false },
  { id: 'phi-4', name: 'Phi-4', provider: 'microsoft', category: 'text', elo: 1290, bestFor: ['reasoning', 'math', 'code'], openSource: true, repo: 'microsoft/phi-4' },
  { id: 'phi-3-5', name: 'Phi-3.5', provider: 'microsoft', category: 'text', elo: 1270, bestFor: ['reasoning', 'code'], openSource: true, repo: 'microsoft/phi-3.5' },
  { id: 'phi-3', name: 'Phi-3', provider: 'microsoft', category: 'text', elo: 1250, bestFor: ['fast', 'on-device'], openSource: true, repo: 'microsoft/phi-3' },
  { id: 'jamba-1-5', name: 'Jamba 1.5', provider: 'ai21', category: 'text', elo: 1290, bestFor: ['long-context', 'general'], openSource: false },
  { id: 'reka-core', name: 'Reka Core', provider: 'reka', category: 'text', elo: 1310, bestFor: ['multimodal', 'general'], openSource: false },
  { id: 'reka-flash', name: 'Reka Flash', provider: 'reka', category: 'text', elo: 1280, bestFor: ['fast', 'multimodal'], openSource: false },
  { id: 'nova-pro', name: 'Nova Pro', provider: 'amazon', category: 'text', elo: 1300, bestFor: ['general', 'multimodal'], openSource: false },
  { id: 'nova-lite', name: 'Nova Lite', provider: 'amazon', category: 'text', elo: 1270, bestFor: ['fast', 'general'], openSource: false },
  { id: 'titan-express', name: 'Titan Express', provider: 'amazon', category: 'text', elo: 1250, bestFor: ['fast', 'cheap'], openSource: false },
  { id: 'ernie-4-5', name: 'ERNIE 4.5', provider: 'baidu', category: 'text', elo: 1320, bestFor: ['general', 'chinese'], openSource: false },
  { id: 'ernie-4-0', name: 'ERNIE 4.0', provider: 'baidu', category: 'text', elo: 1300, bestFor: ['general'], openSource: false },
  { id: 'palmyra-x5', name: 'Palmyra X5', provider: 'writer', category: 'text', elo: 1290, bestFor: ['writing', 'enterprise'], openSource: false },
  { id: 'hermes-3', name: 'Hermes 3', provider: 'nousresearch', category: 'text', elo: 1280, bestFor: ['general', 'roleplay'], openSource: true, repo: 'NousResearch/Hermes-3' },
  { id: 'zephyr', name: 'Zephyr', provider: 'alignment', category: 'text', elo: 1250, bestFor: ['general', 'fast'], openSource: true, repo: 'alignment/zephyr' },
  { id: 'vicuna-33b', name: 'Vicuna 33B', provider: 'lmsys', category: 'text', elo: 1260, bestFor: ['general'], openSource: true, repo: 'lmsys/vicuna' },
  { id: 'alpaca-7b', name: 'Alpaca 7B', provider: 'stanford', category: 'text', elo: 1180, bestFor: ['general', 'fast'], openSource: true, repo: 'tatsu-lab/stanford_alpaca' },
  { id: 'wizardlm-2', name: 'WizardLM 2', provider: 'microsoft', category: 'text', elo: 1280, bestFor: ['code', 'reasoning'], openSource: true, repo: 'microsoft/WizardLM-2' },
  { id: 'falcon-180b', name: 'Falcon 180B', provider: 'tii', category: 'text', elo: 1270, bestFor: ['general'], openSource: true, repo: 'tiiuae/falcon-180B' },
  { id: 'falcon-40b', name: 'Falcon 40B', provider: 'tii', category: 'text', elo: 1250, bestFor: ['general'], openSource: true, repo: 'tiiuae/falcon-40b' },
  { id: 'mpt-30b', name: 'MPT 30B', provider: 'mosaic', category: 'text', elo: 1250, bestFor: ['general', 'long-context'], openSource: true, repo: 'mosaicml/mpt-30b' },
  { id: 'openchat', name: 'OpenChat', provider: 'openchat', category: 'text', elo: 1260, bestFor: ['general'], openSource: true, repo: 'openchat/openchat' },
  { id: 'ultracorb', name: 'UltraCorb', provider: 'corbatai', category: 'text', elo: 1240, bestFor: ['general'], openSource: true, repo: 'corbatai/ultracorb' },
  { id: 'granite-3-1', name: 'Granite 3.1', provider: 'ibm', category: 'text', elo: 1270, bestFor: ['enterprise', 'code'], openSource: true, repo: 'ibm-granite/granite-3.1' },
  { id: 'jais-30b', name: 'Jais 30B', provider: 'inception', category: 'text', elo: 1240, bestFor: ['arabic', 'multilingual'], openSource: true, repo: 'inceptionai/jais-30b' },
  { id: 'dolly', name: 'Dolly', provider: 'databricks', category: 'text', elo: 1200, bestFor: ['general', 'fast'], openSource: true, repo: 'databricks/dolly' },
  { id: 'stable-lm-2', name: 'Stable LM 2', provider: 'stability', category: 'text', elo: 1250, bestFor: ['general', 'open-source'], openSource: true, repo: 'StabilityAI/stable-lm-2' },
  { id: 'capybara', name: 'Capybara', provider: 'nousresearch', category: 'text', elo: 1230, bestFor: ['general'], openSource: true, repo: 'NousResearch/Capybara' },
  { id: 'openhermes-2-5', name: 'OpenHermes 2.5', provider: 'teknium', category: 'text', elo: 1240, bestFor: ['general', 'code'], openSource: true, repo: 'teknium/OpenHermes-2.5' },
  { id: 'huggingchat', name: 'HuggingChat', provider: 'huggingface', category: 'text', elo: 1230, bestFor: ['general'], openSource: true, repo: 'huggingface/huggingchat' },
  { id: 'moonshot-v1', name: 'Moonshot v1', provider: 'moonshot', category: 'text', elo: 1300, bestFor: ['long-context', 'chinese'], openSource: false },
  { id: 'doubao-pro', name: 'Doubao Pro', provider: 'bytedance', category: 'text', elo: 1310, bestFor: ['general', 'chinese'], openSource: false },
  { id: 'doubao-lite', name: 'Doubao Lite', provider: 'bytedance', category: 'text', elo: 1270, bestFor: ['fast', 'chinese'], openSource: false },
  { id: 'pangu-large', name: 'PanGu-Sigma', provider: 'huawei', category: 'text', elo: 1290, bestFor: ['general', 'chinese'], openSource: false },
  { id: 'hunyuan-large', name: 'Hunyuan-Large', provider: 'tencent', category: 'text', elo: 1300, bestFor: ['general', 'multilingual'], openSource: false },
  { id: 'afm-3b', name: 'AFM 3B', provider: 'apple', category: 'text', elo: 1200, bestFor: ['on-device', 'fast'], openSource: false },
  { id: 'pixtral-large', name: 'Pixtral Large', provider: 'mistral', category: 'multimodal', elo: 1320, bestFor: ['multimodal', 'vision'], openSource: false },

  // ═══ CODE MODELS ═══
  { id: 'qwen3-coder-480b', name: 'Qwen3 Coder 480B', provider: 'alibaba', category: 'code', elo: 1387, bestFor: ['code-gen', 'open-source', 'multi-language'], openSource: true, repo: 'QwenLM/Qwen3-Coder' },
  { id: 'starcoder-2', name: 'StarCoder 2', provider: 'bigcode', category: 'code', elo: 1280, bestFor: ['code-gen', 'open-source'], openSource: true, repo: 'bigcode-project/starcoder2' },
  { id: 'starcoder', name: 'StarCoder', provider: 'bigcode', category: 'code', elo: 1250, bestFor: ['code-gen'], openSource: true, repo: 'bigcode-project/starcoder' },
  { id: 'codegemma-7b', name: 'CodeGemma 7B', provider: 'google', category: 'code', elo: 1270, bestFor: ['code-gen', 'fast'], openSource: true, repo: 'google-deepmind/codegemma' },
  { id: 'codegemma-2b', name: 'CodeGemma 2B', provider: 'google', category: 'code', elo: 1230, bestFor: ['code-gen', 'fast'], openSource: true, repo: 'google-deepmind/codegemma' },
  { id: 'phind-model', name: 'Phind Model', provider: 'phind', category: 'code', elo: 1300, bestFor: ['code', 'reasoning'], openSource: false },
  { id: 'codellama-70b', name: 'CodeLlama 70B', provider: 'meta', category: 'code', elo: 1290, bestFor: ['code-gen', 'long-context'], openSource: true, repo: 'meta-llama/codellama' },
  { id: 'codellama-34b', name: 'CodeLlama 34B', provider: 'meta', category: 'code', elo: 1270, bestFor: ['code-gen'], openSource: true, repo: 'meta-llama/codellama' },
  { id: 'codellama-13b', name: 'CodeLlama 13B', provider: 'meta', category: 'code', elo: 1240, bestFor: ['code-gen', 'fast'], openSource: true, repo: 'meta-llama/codellama' },
  { id: 'codellama-7b', name: 'CodeLlama 7B', provider: 'meta', category: 'code', elo: 1210, bestFor: ['code-gen', 'fast'], openSource: true, repo: 'meta-llama/codellama' },
  { id: 'granite-code-34b', name: 'Granite Code 34B', provider: 'ibm', category: 'code', elo: 1270, bestFor: ['code-gen', 'enterprise'], openSource: true, repo: 'ibm-granite/granite-code' },
  { id: 'granite-code-8b', name: 'Granite Code 8B', provider: 'ibm', category: 'code', elo: 1230, bestFor: ['code-gen', 'fast'], openSource: true, repo: 'ibm-granite/granite-code' },
  { id: 'deepseek-coder-33b', name: 'DeepSeek Coder 33B', provider: 'deepseek', category: 'code', elo: 1290, bestFor: ['code-gen'], openSource: true, repo: 'deepseek-ai/DeepSeek-Coder-33B' },
  { id: 'deepseek-coder-6-7b', name: 'DeepSeek Coder 6.7B', provider: 'deepseek', category: 'code', elo: 1250, bestFor: ['code-gen', 'fast'], openSource: true, repo: 'deepseek-ai/DeepSeek-Coder-6.7B' },
  { id: 'magicoder', name: 'Magicoder', provider: 'iseeai', category: 'code', elo: 1270, bestFor: ['code-gen'], openSource: true, repo: 'iseeai/Magicoder' },
  { id: 'sqlcoder', name: 'SQLCoder', provider: 'defog', category: 'code', elo: 1260, bestFor: ['sql', 'data'], openSource: true, repo: 'defog/sqlcoder' },
  { id: 'codeshell', name: 'CodeShell', provider: 'pku', category: 'code', elo: 1240, bestFor: ['code-gen'], openSource: true, repo: '/PKU-CodeShell' },
  { id: 'incoder-6b', name: 'InCoder 6B', provider: 'facebook', category: 'code', elo: 1230, bestFor: ['code-gen', 'fill'], openSource: true, repo: 'facebookresearch/InCoder' },
  { id: 'polycoder', name: 'PolyCoder', provider: 'cmu', category: 'code', elo: 1220, bestFor: ['code-gen'], openSource: true, repo: 'CMU-NLP/polycoder' },
  { id: 'santacoder', name: 'SantaCoder', provider: 'bigcode', category: 'code', elo: 1240, bestFor: ['code-gen'], openSource: true, repo: 'bigcode-project/santacoder' },
  { id: 'codegen-16b', name: 'CodeGen 16B', provider: 'salesforce', category: 'code', elo: 1250, bestFor: ['code-gen'], openSource: true, repo: 'Salesforce/codegen' },
  { id: 'codegen-6b', name: 'CodeGen 6B', provider: 'salesforce', category: 'code', elo: 1230, bestFor: ['code-gen', 'fast'], openSource: true, repo: 'Salesforce/codegen' },
  { id: 'unixcoder', name: 'UniXcoder', provider: 'microsoft', category: 'code', elo: 1260, bestFor: ['code-gen', 'multilingual'], openSource: true, repo: 'microsoft/UniXcoder' },

  // ═══ VISION MODELS ═══
  { id: 'gemini-3-1-pro-vision', name: 'Gemini 3.1 Pro Vision', provider: 'google', category: 'vision', elo: 1388, bestFor: ['image-analysis', 'ocr', 'visual-qa'], openSource: false },
  { id: 'gpt-4o-vision', name: 'GPT-4o Vision', provider: 'openai', category: 'vision', elo: 1370, bestFor: ['image-analysis', 'visual-reasoning'], openSource: false },
  { id: 'claude-fable-5-vision', name: 'Claude Fable 5 Vision', provider: 'anthropic', category: 'vision', elo: 1380, bestFor: ['image-analysis', 'document-qa'], openSource: false },
  { id: 'claude-opus-4-8-vision', name: 'Claude Opus 4.8 Vision', provider: 'anthropic', category: 'vision', elo: 1376, bestFor: ['complex-visual', 'diagrams'], openSource: false },
  { id: 'kimi-k3-vision', name: 'Kimi K3 Vision', provider: 'moonshot', category: 'vision', elo: 1372, bestFor: ['image-analysis', 'ocr'], openSource: false },
  { id: 'qwen-vl-max', name: 'Qwen-VL-Max', provider: 'alibaba', category: 'vision', elo: 1368, bestFor: ['image-analysis', 'multilingual'], openSource: false },
  { id: 'glm-5v', name: 'GLM-5V', provider: 'zhipu', category: 'vision', elo: 1364, bestFor: ['image-analysis', 'chinese'], openSource: false },
  { id: 'llama-4-scout-vision', name: 'Llama 4 Scout Vision', provider: 'meta', category: 'vision', elo: 1360, bestFor: ['image-analysis', 'open-source'], openSource: true, repo: 'meta-llama/llama-models' },
  { id: 'llava-1-6', name: 'LLaVA 1.6', provider: 'llava', category: 'vision', elo: 1280, bestFor: ['image-analysis', 'open-source'], openSource: true, repo: 'haotian-liu/LLaVA' },
  { id: 'internvl-2-5', name: 'InternVL 2.5', provider: 'internvl', category: 'vision', elo: 1340, bestFor: ['image-analysis', 'ocr'], openSource: true, repo: 'OpenGVLab/InternVL' },
  { id: 'cogvlm-2', name: 'CogVLM 2', provider: 'zhipu', category: 'vision', elo: 1300, bestFor: ['image-analysis', 'grounding'], openSource: true, repo: 'THUDM/CogVLM2' },
  { id: 'cogvlm', name: 'CogVLM', provider: 'zhipu', category: 'vision', elo: 1270, bestFor: ['image-analysis'], openSource: true, repo: 'THUDM/CogVLM' },
  { id: 'qwen-vl-plus', name: 'Qwen-VL-Plus', provider: 'alibaba', category: 'vision', elo: 1330, bestFor: ['image-analysis', 'fast'], openSource: false },
  { id: 'qwen-vl-chat', name: 'Qwen-VL-Chat', provider: 'alibaba', category: 'vision', elo: 1280, bestFor: ['image-analysis'], openSource: true, repo: 'QwenLM/Qwen-VL' },
  { id: 'yi-vl-34b', name: 'Yi-VL 34B', provider: '01-ai', category: 'vision', elo: 1310, bestFor: ['image-analysis', 'multilingual'], openSource: true, repo: '01-ai/Yi-VL' },
  { id: 'llama-3-2-90b-vision', name: 'Llama 3.2 90B Vision', provider: 'meta', category: 'vision', elo: 1310, bestFor: ['image-analysis'], openSource: true, repo: 'meta-llama/llama-models' },
  { id: 'llama-3-2-11b-vision', name: 'Llama 3.2 11B Vision', provider: 'meta', category: 'vision', elo: 1270, bestFor: ['image-analysis', 'fast'], openSource: true, repo: 'meta-llama/llama-models' },
  { id: 'moondream2', name: 'Moondream 2', provider: 'moondream', category: 'vision', elo: 1220, bestFor: ['image-analysis', 'tiny'], openSource: true, repo: 'vikhyatk/moondream' },
  { id: 'minicpm-v', name: 'MiniCPM-V', provider: 'openbmb', category: 'vision', elo: 1300, bestFor: ['image-analysis', 'ocr'], openSource: true, repo: 'OpenBMB/MiniCPM-V' },
  { id: 'deepseek-vl-2', name: 'DeepSeek VL 2', provider: 'deepseek', category: 'vision', elo: 1320, bestFor: ['image-analysis', 'document'], openSource: true, repo: 'deepseek-ai/DeepSeek-VL2' },
  { id: ' Florence-2', name: 'Florence-2', provider: 'microsoft', category: 'vision', elo: 1280, bestFor: ['ocr', 'detection'], openSource: true, repo: 'microsoft/Florence-2' },
  { id: 'paligemma-2', name: 'PaliGemma 2', provider: 'google', category: 'vision', elo: 1290, bestFor: ['image-analysis', 'open-source'], openSource: true, repo: 'google-deepmind/paligemma' },

  // ═══ IMAGE GENERATION ═══
  { id: 'dall-e-5', name: 'DALL-E 5', provider: 'openai', category: 'image', elo: 1392, bestFor: ['photorealistic', 'creative', 'design'], openSource: false },
  { id: 'midjourney-v7', name: 'Midjourney V7', provider: 'midjourney', category: 'image', elo: 1388, bestFor: ['artistic', 'creative', 'style'], openSource: false },
  { id: 'stable-diffusion-4', name: 'Stable Diffusion 4', provider: 'stability', category: 'image', elo: 1384, bestFor: ['open-source', 'custom', 'fast'], openSource: true, repo: 'StabilityAI/stable-diffusion' },
  { id: 'imagen-4', name: 'Imagen 4', provider: 'google', category: 'image', elo: 1380, bestFor: ['photorealistic', 'text-rendering'], openSource: false },
  { id: 'flux-2-pro', name: 'Flux 2 Pro', provider: 'black-forest', category: 'image', elo: 1376, bestFor: ['fast', 'quality', 'open-source'], openSource: true, repo: 'black-forest-labs/FLUX' },
  { id: 'flux-1-1-pro', name: 'Flux 1.1 Pro', provider: 'black-forest', category: 'image', elo: 1360, bestFor: ['fast', 'quality'], openSource: false },
  { id: 'ideogram-3', name: 'Ideogram 3', provider: 'ideogram', category: 'image', elo: 1372, bestFor: ['text-in-image', 'design'], openSource: false },
  { id: 'firefly-4', name: 'Firefly 4', provider: 'adobe', category: 'image', elo: 1368, bestFor: ['commercial', 'design', 'editing'], openSource: false },
  { id: 'kling-3', name: 'Kling 3', provider: 'kuaishou', category: 'image', elo: 1364, bestFor: ['video-generation', 'animation'], openSource: false },
  { id: 'cogvideox', name: 'CogVideoX', provider: 'zhipu', category: 'video', elo: 1330, bestFor: ['video-generation'], openSource: true, repo: 'THUDM/CogVideo' },
  { id: 'open-sora', name: 'Open-Sora', provider: 'hpcaitech', category: 'video', elo: 1310, bestFor: ['video-generation', 'open-source'], openSource: true, repo: 'hpcaitech/Open-Sora' },
  { id: 'sdxl-turbo', name: 'SDXL Turbo', provider: 'stability', category: 'image', elo: 1340, bestFor: ['fast', 'real-time'], openSource: true, repo: 'StabilityAI/generative-models' },
  { id: 'playground-v3', name: 'Playground V3', provider: 'playground', category: 'image', elo: 1330, bestFor: ['design', 'commercial'], openSource: false },
  { id: 'leonardo-diffusion', name: 'Leonardo Diffusion', provider: 'leonardo', category: 'image', elo: 1320, bestFor: ['artistic', 'creative'], openSource: false },
  { id: 'dreamshaper-xl', name: 'DreamShaper XL', provider: 'lykon', category: 'image', elo: 1300, bestFor: ['artistic', 'open-source'], openSource: true, repo: 'Lykon/DreamShaper' },
  { id: 'real-esrgan', name: 'Real-ESRGAN', provider: 'xinntao', category: 'image', elo: 1280, bestFor: ['upscale', 'restoration'], openSource: true, repo: 'xinntao/Real-ESRGAN' },
  { id: 'controlnet', name: 'ControlNet', provider: 'lllyasviel', category: 'image', elo: 1300, bestFor: ['control', 'guided'], openSource: true, repo: 'lllyasviel/ControlNet' },
  { id: 'ip-adapter', name: 'IP-Adapter', provider: 'tencent', category: 'image', elo: 1290, bestFor: ['style-transfer', 'reference'], openSource: true, repo: 'tencent-ailab/IP-Adapter' },
  { id: 'instantid', name: 'InstantID', provider: 'instantx', category: 'image', elo: 1310, bestFor: ['face', 'identity'], openSource: true, repo: 'InstantX/InstantID' },
  { id: 'suno-v4', name: 'Suno V4', provider: 'suno', category: 'music', elo: 1370, bestFor: ['music-generation', 'vocal'], openSource: false },

  // ═══ AUDIO/TTS ═══
  { id: 'elevenlabs-v3', name: 'Eleven Multilingual v3', provider: 'elevenlabs', category: 'audio', elo: 1390, bestFor: ['tts', 'voice-cloning', 'multilingual'], openSource: false },
  { id: 'elevenlabs-v2', name: 'Eleven Multilingual v2', provider: 'elevenlabs', category: 'audio', elo: 1370, bestFor: ['tts', 'voice-cloning'], openSource: false },
  { id: 'openai-tts-3', name: 'OpenAI TTS 3', provider: 'openai', category: 'audio', elo: 1386, bestFor: ['tts', 'natural', 'fast'], openSource: false },
  { id: 'bark-2', name: 'Bark 2', provider: 'suno', category: 'audio', elo: 1382, bestFor: ['tts', 'emotional', 'open-source'], openSource: true, repo: 'suno-ai/bark' },
  { id: 'xtts-v3', name: 'XTTS V3', provider: 'coqui', category: 'audio', elo: 1378, bestFor: ['voice-cloning', 'open-source'], openSource: true, repo: 'coqui-ai/TTS' },
  { id: 'piper-tts', name: 'Piper TTS', provider: 'rhasspy', category: 'audio', elo: 1374, bestFor: ['local', 'fast', 'open-source'], openSource: true, repo: 'rhasspy/piper' },
  { id: 'whisper-v4', name: 'Whisper V4', provider: 'openai', category: 'audio', elo: 1390, bestFor: ['stt', 'transcription', 'multilingual'], openSource: true, repo: 'openai/whisper' },
  { id: 'deepgram-nova-3', name: 'Deepgram Nova 3', provider: 'deepgram', category: 'audio', elo: 1386, bestFor: ['stt', 'real-time', 'enterprise'], openSource: false },
  { id: 'assemblyai-3', name: 'AssemblyAI 3', provider: 'assemblyai', category: 'audio', elo: 1382, bestFor: ['stt', 'accuracy', 'enterprise'], openSource: false },
  { id: 'azure-tts', name: 'Azure Neural TTS', provider: 'microsoft', category: 'audio', elo: 1370, bestFor: ['tts', 'enterprise'], openSource: false },
  { id: 'google-tts', name: 'Google Cloud TTS', provider: 'google', category: 'audio', elo: 1365, bestFor: ['tts', 'multilingual'], openSource: false },
  { id: 'amazon-polly', name: 'Amazon Polly', provider: 'amazon', category: 'audio', elo: 1350, bestFor: ['tts', 'enterprise'], openSource: false },
  { id: 'bark', name: 'Bark', provider: 'suno', category: 'audio', elo: 1330, bestFor: ['tts', 'emotional'], openSource: true, repo: 'suno-ai/bark' },
  { id: 'tortoise-tts', name: 'Tortoise TTS', provider: 'neonbjb', category: 'audio', elo: 1320, bestFor: ['tts', 'quality'], openSource: true, repo: 'neonbjb/tortoise-tts' },
  { id: 'melo-tts', name: 'MeloTTS', provider: 'myshell', category: 'audio', elo: 1310, bestFor: ['tts', 'fast'], openSource: true, repo: 'myshell-ai/MeloTTS' },
  { id: 'spark-tts', name: 'Spark TTS', provider: 'spark', category: 'audio', elo: 1300, bestFor: ['tts', 'open-source'], openSource: true, repo: 'spark-ai/spark-tts' },
  { id: 'fish-speech', name: 'Fish Speech', provider: 'fishaudio', category: 'audio', elo: 1310, bestFor: ['tts', 'voice-cloning'], openSource: true, repo: 'fishaudio/fish-speech' },
  { id: 'gpt-sovits', name: 'GPT-SoVITS', provider: 'rvc', category: 'audio', elo: 1300, bestFor: ['voice-cloning', 'tts'], openSource: true, repo: 'RVC-Boss/GPT-SoVITS' },
  { id: 'style-tts-2', name: 'StyleTTS 2', provider: 'styletts', category: 'audio', elo: 1290, bestFor: ['tts', 'style'], openSource: true, repo: 'yl4579/StyleTTS2' },
  { id: 'vall-e-x', name: 'VALL-E X', provider: 'microsoft', category: 'audio', elo: 1340, bestFor: ['voice-cloning', 'multilingual'], openSource: false },
  { id: 'natural-hierarchy', name: 'Natural Hierarchy', provider: 'elevenlabs', category: 'audio', elo: 1350, bestFor: ['tts', 'natural'], openSource: false },

  // ═══ REASONING ═══
  { id: 'o3-max', name: 'o3 Max', provider: 'openai', category: 'reasoning', elo: 1395, bestFor: ['complex-reasoning', 'math', 'code'], openSource: false },
  { id: 'o3-pro', name: 'o3 Pro', provider: 'openai', category: 'reasoning', elo: 1385, bestFor: ['reasoning', 'planning'], openSource: false },
  { id: 'claude-fable-5-reasoning', name: 'Claude Fable 5 (Reasoning)', provider: 'anthropic', category: 'reasoning', elo: 1394, bestFor: ['complex-reasoning', 'planning', 'analysis'], openSource: false },
  { id: 'gemini-2-5-pro-reasoning', name: 'Gemini 2.5 Pro (Reasoning)', provider: 'google', category: 'reasoning', elo: 1380, bestFor: ['multimodal-reasoning', 'search'], openSource: false },
  { id: 'deepseek-r1-671b', name: 'DeepSeek R1 671B', provider: 'deepseek', category: 'reasoning', elo: 1375, bestFor: ['math', 'code', 'reasoning'], openSource: true, repo: 'deepseek-ai/DeepSeek-R1' },
  { id: 'qwen-qwq-32b', name: 'QwQ 32B', provider: 'alibaba', category: 'reasoning', elo: 1360, bestFor: ['reasoning', 'math'], openSource: true, repo: 'QwenLM/QwQ' },
  { id: 'phi-4-reasoning', name: 'Phi-4 Reasoning', provider: 'microsoft', category: 'reasoning', elo: 1340, bestFor: ['reasoning', 'math', 'code'], openSource: true, repo: 'microsoft/phi-4' },
  { id: 'grok-3-reasoning', name: 'Grok 3 (Reasoning)', provider: 'xai', category: 'reasoning', elo: 1360, bestFor: ['reasoning', 'math'], openSource: false },
  { id: 'kimi-k3-reasoning', name: 'Kimi K3 (Reasoning)', provider: 'moonshot', category: 'reasoning', elo: 1365, bestFor: ['math', 'code-reasoning'], openSource: false },
  { id: 'glm-5-2-reasoning', name: 'GLM 5.2 (Reasoning)', provider: 'zhipu', category: 'reasoning', elo: 1350, bestFor: ['reasoning', 'math'], openSource: false },

  // ═══ MULTIMODAL ═══
  { id: 'gemini-3-1-pro-mm', name: 'Gemini 3.1 Pro (Multimodal)', provider: 'google', category: 'multimodal', elo: 1385, bestFor: ['multimodal', 'vision', 'text', 'code'], openSource: false },
  { id: 'gpt-4o-mm', name: 'GPT-4o (Multimodal)', provider: 'openai', category: 'multimodal', elo: 1370, bestFor: ['multimodal', 'vision', 'text'], openSource: false },
  { id: 'claude-sonnet-4-5-mm', name: 'Claude Sonnet 4.5 (Multimodal)', provider: 'anthropic', category: 'multimodal', elo: 1360, bestFor: ['multimodal', 'vision', 'code'], openSource: false },
  { id: 'gemini-2-5-pro-mm', name: 'Gemini 2.5 Pro (Multimodal)', provider: 'google', category: 'multimodal', elo: 1350, bestFor: ['multimodal', 'vision'], openSource: false },
  { id: 'gemini-2-0-flash-mm', name: 'Gemini 2.0 Flash (Multimodal)', provider: 'google', category: 'multimodal', elo: 1330, bestFor: ['multimodal', 'fast'], openSource: false },
  { id: 'pixtral-large-mm', name: 'Pixtral Large (Multimodal)', provider: 'mistral', category: 'multimodal', elo: 1320, bestFor: ['multimodal', 'vision'], openSource: false },
  { id: 'qwen-2-5-vl-72b', name: 'Qwen 2.5 VL 72B', provider: 'alibaba', category: 'multimodal', elo: 1340, bestFor: ['multimodal', 'vision'], openSource: true, repo: 'QwenLM/Qwen2.5-VL' },
  { id: 'llama-4-maverick-mm', name: 'Llama 4 Maverick (Multimodal)', provider: 'meta', category: 'multimodal', elo: 1335, bestFor: ['multimodal', 'vision'], openSource: true, repo: 'meta-llama/llama-models' },

  // ═══ EMBEDDING ═══
  { id: 'text-embedding-3-large', name: 'Text Embedding 3 Large', provider: 'openai', category: 'embedding', elo: 1350, bestFor: ['embeddings', 'search', 'similarity'], openSource: false },
  { id: 'text-embedding-3-small', name: 'Text Embedding 3 Small', provider: 'openai', category: 'embedding', elo: 1330, bestFor: ['embeddings', 'fast'], openSource: false },
  { id: 'voyage-3', name: 'Voyage 3', provider: 'voyage', category: 'embedding', elo: 1345, bestFor: ['embeddings', 'code'], openSource: false },
  { id: 'cohere-embed-v3', name: 'Cohere Embed V3', provider: 'cohere', category: 'embedding', elo: 1340, bestFor: ['embeddings', 'multilingual'], openSource: false },
  { id: 'e5-mistral-7b', name: 'E5 Mistral 7B', provider: 'microsoft', category: 'embedding', elo: 1320, bestFor: ['embeddings', 'open-source'], openSource: true, repo: 'microsoft/unilm' },
  { id: 'bge-large', name: 'BGE Large', provider: 'baidu', category: 'embedding', elo: 1310, bestFor: ['embeddings', 'multilingual'], openSource: true, repo: 'BAAI/bge-large' },
  { id: 'bge-m3', name: 'BGE M3', provider: 'baidu', category: 'embedding', elo: 1325, bestFor: ['embeddings', 'multilingual'], openSource: true, repo: 'BAAI/bge-m3' },
  { id: 'nomic-embed', name: 'Nomic Embed', provider: 'nomic', category: 'embedding', elo: 1300, bestFor: ['embeddings', 'open-source'], openSource: true, repo: 'nomic-ai/nomic-embed' },
  { id: 'jina-embeddings-v3', name: 'Jina Embeddings V3', provider: 'jina', category: 'embedding', elo: 1315, bestFor: ['embeddings', 'multilingual'], openSource: false },
  { id: 'gte-qwen2', name: 'GTE-Qwen2', provider: 'alibaba', category: 'embedding', elo: 1310, bestFor: ['embeddings', 'multilingual'], openSource: true, repo: 'Alibaba-NLP/gte-Qwen2' },
  { id: 'snowflake-arctic-embed-l', name: 'Snowflake Arctic Embed L', provider: 'snowflake', category: 'embedding', elo: 1305, bestFor: ['embeddings'], openSource: true, repo: 'Snowflake-Labs/snowflake-arctic-embed' },
  { id: 'mxbai-embed-large', name: 'MXBai Embed Large', provider: 'mixedbread', category: 'embedding', elo: 1300, bestFor: ['embeddings'], openSource: true, repo: 'mixedbread-ai/mxbai-embed-large' },

  // ═══ VIDEO ═══
  { id: 'sora', name: 'Sora', provider: 'openai', category: 'video', elo: 1390, bestFor: ['video-generation', 'creative'], openSource: false },
  { id: 'veo-2', name: 'Veo 2', provider: 'google', category: 'video', elo: 1380, bestFor: ['video-generation', 'quality'], openSource: false },
  { id: 'runway-gen-3', name: 'Runway Gen-3', provider: 'runway', category: 'video', elo: 1370, bestFor: ['video-generation', 'creative'], openSource: false },
  { id: 'pika-2', name: 'Pika 2', provider: 'pika', category: 'video', elo: 1350, bestFor: ['video-generation', 'fast'], openSource: false },
  { id: 'kling-video', name: 'Kling Video', provider: 'kuaishou', category: 'video', elo: 1360, bestFor: ['video-generation', 'quality'], openSource: false },
  { id: 'stable-video-diffusion', name: 'Stable Video Diffusion', provider: 'stability', category: 'video', elo: 1330, bestFor: ['video-generation', 'open-source'], openSource: true, repo: 'StabilityAI/stable-video-diffusion' },
  { id: 'open-sora-plan', name: 'Open-Sora Plan', provider: 'hpcaitech', category: 'video', elo: 1310, bestFor: ['video-generation', 'open-source'], openSource: true, repo: 'hpcaitech/Open-Sora-Plan' },
  { id: 'cogvideox-5b', name: 'CogVideoX 5B', provider: 'zhipu', category: 'video', elo: 1320, bestFor: ['video-generation'], openSource: true, repo: 'THUDM/CogVideo' },
  { id: 'mochi-1', name: 'Mochi 1', provider: 'genmo', category: 'video', elo: 1340, bestFor: ['video-generation', 'motion'], openSource: true, repo: 'genmoai/mochi' },
  { id: 'hunyuan-video', name: 'Hunyuan Video', provider: 'tencent', category: 'video', elo: 1335, bestFor: ['video-generation'], openSource: true, repo: 'Tencent/HunyuanVideo' },

  // ═══ MUSIC ═══
  { id: 'suno-v4-music', name: 'Suno V4', provider: 'suno', category: 'music', elo: 1370, bestFor: ['music-generation', 'vocal'], openSource: false },
  { id: 'udio-v2', name: 'Udio V2', provider: 'udio', category: 'music', elo: 1360, bestFor: ['music-generation', 'style'], openSource: false },
  { id: 'musicgen-large', name: 'MusicGen Large', provider: 'meta', category: 'music', elo: 1320, bestFor: ['music-generation', 'open-source'], openSource: true, repo: 'facebookresearch/audiocraft' },
  { id: 'musicgen-medium', name: 'MusicGen Medium', provider: 'meta', category: 'music', elo: 1300, bestFor: ['music-generation', 'fast'], openSource: true, repo: 'facebookresearch/audiocraft' },
  { id: 'stable-audio', name: 'Stable Audio', provider: 'stability', category: 'music', elo: 1310, bestFor: ['music-generation', 'sound-effects'], openSource: false },
  { id: 'riffusion', name: 'Riffusion', provider: 'riffusion', category: 'music', elo: 1280, bestFor: ['music-generation', 'open-source'], openSource: true, repo: 'riffusion/riffusion' },
];

export function selectBestModel(taskType, query) {
  var q = (query || '').toLowerCase();
  var candidates = AI_REGISTRY.filter(function(m) { return m.category === taskType || m.bestFor.some(function(b) { return q.includes(b); }); });
  if (!candidates.length) candidates = AI_REGISTRY.filter(function(m) { return m.category === 'text'; });
  candidates.sort(function(a, b) { return b.elo - a.elo; });
  return candidates[0] || AI_REGISTRY[0];
}

export function getModelsByCategory(category) {
  return AI_REGISTRY.filter(function(m) { return m.category === category; }).sort(function(a, b) { return b.elo - a.elo; });
}

export function searchModels(query) {
  var q = (query || '').toLowerCase();
  return AI_REGISTRY.filter(function(m) {
    return m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.bestFor.some(function(b) { return b.includes(q); });
  });
}

// ═══════════════════════════════════════════
// COGNITIVE PROFILES — The translator's map
// ═══════════════════════════════════════════

var PROVIDER_PROFILES = {
  anthropic: { thinkingStyle: 'structured', outputFormat: 'markdown', promptStyle: 'cautious', maxContextLength: 2000, chainCompatibility: ['openai', 'google', 'deepseek'], failureModes: ['over-hedging', 'refusal-on-edge-cases'] },
  openai: { thinkingStyle: 'direct', outputFormat: 'markdown', promptStyle: 'direct', maxContextLength: 1800, chainCompatibility: ['anthropic', 'google', 'mistral'], failureModes: ['confidence-without-evidence', 'hallucination-on-niche-topics'] },
  google: { thinkingStyle: 'balanced', outputFormat: 'markdown', promptStyle: 'balanced', maxContextLength: 2200, chainCompatibility: ['anthropic', 'openai', 'deepseek'], failureModes: ['verbosity', 'hedging-on-technical'] },
  deepseek: { thinkingStyle: 'chain-of-thought', outputFormat: 'structured', promptStyle: 'analytical', maxContextLength: 2000, chainCompatibility: ['anthropic', 'alibaba', 'meta'], failureModes: ['over-reasoning', 'slow-on-simple-tasks'] },
  alibaba: { thinkingStyle: 'structured', outputFormat: 'markdown', promptStyle: 'balanced', maxContextLength: 1800, chainCompatibility: ['deepseek', 'anthropic', 'meta'], failureModes: ['verbosity', 'inconsistent-on-edge-cases'] },
  meta: { thinkingStyle: 'balanced', outputFormat: 'markdown', promptStyle: 'direct', maxContextLength: 1600, chainCompatibility: ['deepseek', 'mistral', 'alibaba'], failureModes: ['sycophancy', 'over-qualification'] },
  mistral: { thinkingStyle: 'direct', outputFormat: 'markdown', promptStyle: 'direct', maxContextLength: 1600, chainCompatibility: ['openai', 'anthropic', 'meta'], failureModes: ['brevity-at-cost-of-detail', 'european-bias'] },
  xai: { thinkingStyle: 'direct', outputFormat: 'markdown', promptStyle: 'casual', maxContextLength: 1500, chainCompatibility: ['openai', 'google'], failureModes: ['casualness-on-formal-topics', 'real-time-data-bias'] },
  moonshot: { thinkingStyle: 'chain-of-thought', outputFormat: 'structured', promptStyle: 'analytical', maxContextLength: 2000, chainCompatibility: ['deepseek', 'alibaba'], failureModes: ['over-structured', 'slow-inference'] },
  zhipu: { thinkingStyle: 'chain-of-thought', outputFormat: 'structured', promptStyle: 'analytical', maxContextLength: 1800, chainCompatibility: ['deepseek', 'alibaba'], failureModes: ['chinese-bias', 'formality'] },
  nvidia: { thinkingStyle: 'balanced', outputFormat: 'markdown', promptStyle: 'direct', maxContextLength: 1600, chainCompatibility: ['meta', 'deepseek'], failureModes: ['marketing-bias', 'generalist-at-cost'] },
  cohere: { thinkingStyle: 'structured', outputFormat: 'markdown', promptStyle: 'balanced', maxContextLength: 1800, chainCompatibility: ['openai', 'anthropic'], failureModes: ['rag-focused', 'limited-reasoning'] },
  microsoft: { thinkingStyle: 'structured', outputFormat: 'markdown', promptStyle: 'cautious', maxContextLength: 1600, chainCompatibility: ['openai', 'meta'], failureModes: ['enterprise-caution', 'conservative'] },
  '01-ai': { thinkingStyle: 'balanced', outputFormat: 'markdown', promptStyle: 'balanced', maxContextLength: 1600, chainCompatibility: ['alibaba', 'deepseek'], failureModes: ['inconsistency', 'multilingual-drift'] },
};

var CATEGORY_PROFILES = {
  text: { thinkingStyle: 'balanced', outputFormat: 'markdown', promptStyle: 'balanced' },
  code: { thinkingStyle: 'structured', outputFormat: 'code', promptStyle: 'direct' },
  reasoning: { thinkingStyle: 'chain-of-thought', outputFormat: 'structured', promptStyle: 'analytical' },
  vision: { thinkingStyle: 'direct', outputFormat: 'markdown', promptStyle: 'direct' },
  multimodal: { thinkingStyle: 'balanced', outputFormat: 'markdown', promptStyle: 'balanced' },
  audio: { thinkingStyle: 'direct', outputFormat: 'text', promptStyle: 'direct' },
  image: { thinkingStyle: 'creative', outputFormat: 'text', promptStyle: 'creative' },
  video: { thinkingStyle: 'creative', outputFormat: 'text', promptStyle: 'creative' },
  music: { thinkingStyle: 'creative', outputFormat: 'text', promptStyle: 'creative' },
  embedding: { thinkingStyle: 'direct', outputFormat: 'text', promptStyle: 'direct' },
};

function getCognitiveProfile(model) {
  if (!model) return { thinkingStyle: 'balanced', outputFormat: 'markdown', promptStyle: 'balanced', maxContextLength: 1800, chainCompatibility: [], failureModes: [] };

  var providerProfile = PROVIDER_PROFILES[model.provider] || { thinkingStyle: 'balanced', outputFormat: 'markdown', promptStyle: 'balanced', maxContextLength: 1800, chainCompatibility: [], failureModes: [] };
  var categoryProfile = CATEGORY_PROFILES[model.category] || CATEGORY_PROFILES.text;

  var profile = {
    thinkingStyle: providerProfile.thinkingStyle || categoryProfile.thinkingStyle,
    outputFormat: providerProfile.outputFormat || categoryProfile.outputFormat,
    promptStyle: providerProfile.promptStyle || categoryProfile.promptStyle,
    maxContextLength: providerProfile.maxContextLength || 1800,
    chainCompatibility: providerProfile.chainCompatibility || [],
    failureModes: providerProfile.failureModes || [],
  };

  // Bug real encontrado en vivo (2026-07-28): crew.js llama a esta funcion
  // con un descriptor parcial ({provider, category}, sin `.name`) desde
  // translateInput() cuando hay resultados de pasos previos que traducir
  // -- crasheaba con "Cannot read properties of undefined (reading
  // 'indexOf')" en cuanto un run de crew.js llegaba a un segundo paso con
  // exito, lo cual nunca habia pasado antes porque ese camino siempre
  // fallaba antes de llegar aqui. `model.name` ahora se trata como
  // opcional, igual que ya se trataba `model` entero unas lineas arriba.
  var modelName = model.name || '';
  if (modelName.indexOf('Reasoning') !== -1 || model.category === 'reasoning') {
    profile.thinkingStyle = 'chain-of-thought';
    profile.promptStyle = 'analytical';
  }
  if (modelName.indexOf('Coder') !== -1 || model.category === 'code') {
    profile.thinkingStyle = 'structured';
    profile.outputFormat = 'code';
  }

  return profile;
}

function getModelById(id) {
  return AI_REGISTRY.find(function(m) { return m.id === id; }) || null;
}

function getChainCompatibleModels(modelId) {
  var model = getModelById(modelId);
  if (!model) return [];
  var profile = getCognitiveProfile(model);
  return AI_REGISTRY.filter(function(m) {
    return profile.chainCompatibility.indexOf(m.provider) !== -1;
  });
}

// ═══════════════════════════════════════════════════════════════
// TINKER FINE-TUNING — Thinking Machines Lab API
// https://thinkingmachines.ai/tinker/
// Managed LoRA fine-tuning for open-source models
// Models: Qwen3.5-4B to Kimi-K2.6 (large MoEs)
// ═══════════════════════════════════════════════════════════════

var TINKER_MODELS = [
  { id: 'qwen3.5-4b', name: 'Qwen3.5-4B', provider: 'alibaba', category: 'text', tinkerReady: true },
  { id: 'qwen3-235b', name: 'Qwen3 235B', provider: 'alibaba', category: 'text', tinkerReady: true },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', provider: 'moonshot', category: 'text', tinkerReady: true },
  { id: 'llama-4-maverick', name: 'Llama 4 Maverick', provider: 'meta', category: 'text', tinkerReady: true },
  { id: 'deepseek-v4', name: 'DeepSeek V4', provider: 'deepseek', category: 'text', tinkerReady: true },
];

function getTinkerReadyModels() {
  return TINKER_MODELS.filter(function(m) { return m.tinkerReady; });
}

function getModelForTinker(modelId) {
  return TINKER_MODELS.find(function(m) { return m.id === modelId; }) || null;
}

export {
  PROVIDER_PROFILES,
  CATEGORY_PROFILES,
  getCognitiveProfile,
  getModelById,
  getChainCompatibleModels,
  TINKER_MODELS,
  getTinkerReadyModels,
  getModelForTinker,
};
