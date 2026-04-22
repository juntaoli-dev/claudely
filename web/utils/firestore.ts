// Stubbed: Claudely removed Firebase/Firestore. Web dashboard pages referencing
// these services are disabled; stubs exist only so Next.js can typecheck.

const notAvailable = async () => { throw new Error('Firestore disabled in Claudely'); };

export const FirestoreSessionService = {
    getSessions: notAvailable,
    getSession: notAvailable,
    createSession: notAvailable,
    updateSession: notAvailable,
    deleteSession: notAvailable,
    getSessionDetails: notAvailable,
};

export const FirestoreUserService = {
    getUser: notAvailable,
    setUser: notAvailable,
    deleteUser: notAvailable,
};

export const FirestorePromptPresetService = {
    getPresets: notAvailable,
    createPreset: notAvailable,
    updatePreset: notAvailable,
    deletePreset: notAvailable,
};

export const FirestoreTranscriptService = {
    getTranscripts: notAvailable,
    addTranscript: notAvailable,
};

export const FirestoreAiMessageService = {
    getMessages: notAvailable,
    addMessage: notAvailable,
};

export const FirestoreSummaryService = {
    getSummary: notAvailable,
    saveSummary: notAvailable,
};

export const convertFirestoreSession: any = (s: any) => s;
export const convertFirestorePreset: any = (p: any) => p;
