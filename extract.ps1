
Add-Type -AssemblyName System.IO.Compression.FileSystem
$files = @(
    @{ docx = 'c:\Users\hp\Desktop\react native project\node\doc\DDdesk_ai_Complete_Feature_Specification.docx'; out = 'c:\Users\hp\Desktop\react native project\node\doc\spec_extracted.txt' },
    @{ docx = 'c:\Users\hp\Desktop\react native project\node\doc\DDdesk_ai_Product_Requirements_Document_PRD.docx'; out = 'c:\Users\hp\Desktop\react native project\node\doc\prd_extracted.txt' }
)

foreach ($f in $files) {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($f.docx)
    $entry = $zip.GetEntry('word/document.xml')
    $stream = $entry.Open()
    $reader = New-Object System.IO.StreamReader($stream)
    $xmlContent = $reader.ReadToEnd()
    $reader.Close()
    $stream.Close()
    $zip.Dispose()
    
    $xml = [xml]$xmlContent
    $ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
    $ns.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
    $paragraphs = $xml.SelectNodes('//w:p', $ns)
    $lines = @()
    foreach ($p in $paragraphs) {
        $texts = $p.SelectNodes('.//w:t', $ns)
        $line = ''
        foreach ($t in $texts) {
            $line += $t.InnerText
        }
        if ($line.Trim() -ne '') {
            $lines += $line
        }
    }
    $lines | Out-File -FilePath $f.out -Encoding utf8
}
Write-Host "Extraction completed successfully."
