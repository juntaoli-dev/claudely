// factory.js

function createAIProvider() {
    throw new Error('Local CLI assistant provider is wired through AssistantSession');
}

module.exports = { createAIProvider };
