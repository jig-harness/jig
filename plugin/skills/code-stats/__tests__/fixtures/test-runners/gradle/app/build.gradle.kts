plugins { kotlin("jvm") }

sourceSets {
    test {
        kotlin.srcDir("checks")
    }
}
