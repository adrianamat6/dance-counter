package com.adrianamat.dancecounter;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

/**
 * Main Android activity.
 *
 * Capacitor already provides the WebChromeClient used by its WebView and
 * handles WebView permission requests. Do not replace it here: doing so can
 * break navigator.mediaDevices.getUserMedia() in the APK.
 */
public class MainActivity extends BridgeActivity {

    private ActivityResultLauncher<String> microphonePermissionLauncher;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        microphonePermissionLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestPermission(),
                granted -> {
                    // The WebView will request the permission again through
                    // Capacitor when getUserMedia() is called.
                }
        );

        requestMicrophonePermissionIfNeeded();
    }

    private void requestMicrophonePermissionIfNeeded() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            microphonePermissionLauncher.launch(Manifest.permission.RECORD_AUDIO);
        }
    }
}