// --------------------------
// SAVE SETTINGS + GENERATE PIN (FORCED, WITH DEBUG LOGS)
// --------------------------
app.post('/save-config', async (req, res) => {
  try {
    // Save basic settings
    APP_CONFIG.simklClientId = req.body.simklClientId;
    APP_CONFIG.watchThreshold = parseInt(req.body.watchThreshold);
    APP_CONFIG.syncWatchingNow = req.body.syncWatchingNow === 'true';
    APP_CONFIG.syncFullProgress = req.body.syncFullProgress === 'true';

    // Reset PIN and token
    APP_CONFIG.simklUserCode = '';
    APP_CONFIG.simklToken = '';
    APP_CONFIG.simklVerifier = '';

    console.log("🔑 Trying to generate PIN with Client ID:", APP_CONFIG.simklClientId);

    // Explicitly call Simkl PIN API
    const apiUrl = `${SIMKL.PIN_CREATE}?client_id=${APP_CONFIG.simklClientId}`;
    const response = await fetch(apiUrl);
    const data = await response.json();

    console.log("📥 Simkl PIN API response:", data);

    // If successful, save the PIN
    if (data.userCode && data.verifier) {
      APP_CONFIG.simklUserCode = data.userCode;
      APP_CONFIG.simklVerifier = data.verifier;
      console.log("✅ PIN generated successfully:", APP_CONFIG.simklUserCode);
    } else {
      console.error("❌ Failed to generate PIN. API response:", data);
    }

    saveConfig();
    res.redirect('/configure');
  } catch (error) {
    console.error("❌ Error generating PIN:", error);
    saveConfig();
    res.redirect('/configure');
  }
});