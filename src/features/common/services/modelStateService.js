// Stubbed: Claudely uses local CLI assistants, no provider-key UI.
const { EventEmitter } = require('events');

class ModelStateService extends EventEmitter {
    async initialize() {}

    async getLiveState() {
        return { apiKeys: {}, selectedModels: { llm: null, stt: null } };
    }

    async setApiKey() { return { success: true }; }
    async getAllApiKeys() { return {}; }
    async removeApiKey() { return false; }
    async handleRemoveApiKey() { return false; }
    async handleValidateKey() { return { success: true }; }
    async handleSetSelectedModel() { return true; }
    async setSelectedModel() { return true; }
    async getSelectedModels() { return { llm: null, stt: null }; }
    async getAvailableModels() { return []; }
    async getCurrentModelInfo() { return null; }
    getProviderConfig() { return {}; }
    async hasValidApiKey() { return true; }
    async areProvidersConfigured() { return true; }
    async setFirebaseVirtualKey() {}
    getProviderForModel() { return null; }
    isLoggedInWithFirebase() { return false; }
}

const modelStateService = new ModelStateService();
module.exports = modelStateService;
